import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ClientConnection,
  ContentBlock,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { BackendManifest } from "./config.js";
import { HlaoError, describeError } from "./errors.js";
import { EventLog } from "./events.js";
import { generateMessageId } from "./ids.js";
import { nowIso } from "./time.js";
import { VERSION } from "./version.js";
import type {
  EventType,
  EventView,
  PermissionPolicy,
  QueueItemView,
  SessionConfigOptionView,
  SessionModes,
  SessionStatus,
  SessionUsageView,
  SessionView,
  StopReason,
  WaitUntil,
} from "./protocol.js";
import { ACP_PROTOCOL_VERSION, MAX_PROMPT_CHARS, isTerminalStatus } from "./protocol.js";
import { raceWithTimeout, withTimeout } from "./session/async.js";
import {
  cancelledResponse,
  chooseByPolicy,
  pickAllowOption,
  selectedResponse,
  type PendingPermission,
} from "./session/permissions.js";
import {
  killProcessTree,
  signalProcessGroup,
  waitForExit,
} from "./session/process.js";
import {
  eventTitle,
  previewText,
  projectUpdate,
  queueItemView,
  skillPointer,
  toConfigOptionViews,
  toPermissionView,
} from "./session/projection.js";
import {
  createQueueItem,
  type PromptCompletion,
  type QueueItem,
} from "./session/queue.js";

export type { PromptCompletion } from "./session/queue.js";

const MAX_QUEUED_PROMPTS = 1_000;

export interface SessionConfig {
  startupTimeoutMs: number;
  maxEventsPerSession: number;
  maxEventLogBytes: number;
  maxEventBytes: number;
}

export interface SpawnOptions {
  id: string;
  backend: BackendManifest;
  cwd: string;
  parentId: string | null;
  rootId: string;
  depth: number;
  name: string | null;
  /** "operator" or the requesting session id. Provenance only. */
  createdBy: string;
  requestedMode?: string;
  env: Record<string, string>;
  permissionPolicy: PermissionPolicy;
  home: string;
  config: SessionConfig;
  cliPath: string;
  /** Include the skill pointer in the first prompt. Default true at the boundary. */
  skill: boolean;
  skillPath: string;
  skillVersion: string;
  log: (line: string) => void;
}


export interface SendResult {
  messageId: string;
  queued: boolean;
  turn: number | null;
  completed: boolean;
  timedOut: boolean;
  stopReason?: StopReason;
  text?: string;
  outcome?: "completed" | "cancelled" | "timed_out";
  duplicate?: boolean;
}

export interface ReadOptions {
  since?: number;
  before?: number;
  limit?: number;
  raw?: boolean;
  types?: EventType[];
  turn?: number;
  grep?: string;
}

export interface ReadResult {
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;
  nextBefore: number | null;
  hasMore: boolean;
  truncated: boolean;
}

export interface WaitResult {
  satisfied: boolean;
  reason: WaitUntil | "timeout";
  waitedMs: number;
}


/**
 * One ACP-backed session. One adapter process, one ACP session, one serialized
 * prompt queue. All orchestration state lives here and nowhere else.
 */
export class Session {
  readonly id: string;
  #name: string | null;
  get name(): string | null {
    return this.#name;
  }
  readonly backend: string;
  readonly cwd: string;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly depth: number;
  readonly createdAt: string;
  readonly requestedMode: string | null;

  #child: ChildProcess | null = null;
  #conn: ClientConnection | null = null;
  #agentSessionId: string | null = null;
  #caps: AgentCapabilities = {};
  #modes: SessionModes | null = null;
  #configOptions: SessionConfigOptionView[] | null = null;
  #log: EventLog;
  #status: SessionStatus = "starting";
  #turn = 0;
  #turnStartedAt: string | null = null;
  #queue: QueueItem[] = [];
  #active: QueueItem | null = null;
  #pumping = false;
  #turnText = "";
  #lastMessageId: string | null = null;
  #pending: PendingPermission | null = null;
  #lastStopReason: StopReason | null = null;
  #usage: SessionUsageView | null = null;
  #lastActivityAt: string;
  #endedAt: string | null = null;
  #exit: { code: number | null; signal: string | null } | null = null;
  #closing = false;
  #closingBy: string | null = null;
  #cancelling = false;
  #ready = false;
  #waiters = new Set<() => void>();
  #changeListeners = new Set<() => void>();
  #lastEvent: SessionView["lastEvent"] = null;
  #stderrTail: string[] = [];
  #config: SessionConfig;
  #backendManifest: BackendManifest;
  #permissionPolicy: PermissionPolicy;
  #env: Record<string, string>;
  #home: string;
  #cliPath: string;
  #skillEnabled: boolean;
  #skillPath: string;
  #skillVersion: string;
  #skillInjected = false;
  #createdBy: string;
  #idempotency = new Map<string, { messageId: string; at: number }>();
  #logLine: (line: string) => void;
  #startupError: Error | null = null;

  private constructor(options: SpawnOptions) {
    this.id = options.id;
    this.#name = options.name;
    this.backend = options.backend.name;
    this.cwd = options.cwd;
    this.parentId = options.parentId;
    this.rootId = options.rootId;
    this.depth = options.depth;
    this.createdAt = nowIso();
    this.requestedMode = options.requestedMode ?? null;
    this.#lastActivityAt = this.createdAt;
    this.#config = options.config;
    this.#backendManifest = options.backend;
    this.#permissionPolicy = options.permissionPolicy;
    this.#env = options.env;
    this.#home = options.home;
    this.#cliPath = options.cliPath;
    this.#skillEnabled = options.skill;
    this.#skillPath = options.skillPath;
    this.#skillVersion = options.skillVersion;
    this.#createdBy = options.createdBy;
    this.#logLine = options.log;
    this.#log = new EventLog({
      maxEvents: options.config.maxEventsPerSession,
      maxBytes: options.config.maxEventLogBytes,
      maxEventBytes: options.config.maxEventBytes,
    });
  }

  static async spawn(options: SpawnOptions): Promise<Session> {
    const session = new Session(options);
    await session.#start();
    return session;
  }

  /**
   * Observe state changes and appended events. The listener is called after the
   * event log or session state has changed, so a reader may immediately read
   * from its cursor. Returns an unsubscribe function. This is the same point
   * that wakes `waitFor`; it creates no timer.
   */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  get isTerminal(): boolean {
    return isTerminalStatus(this.#status);
  }

  view(): SessionView {
    const pending = this.#pending;
    return {
      id: this.id,
      name: this.name,
      createdBy: this.#createdBy,
      backend: this.backend,
      cwd: this.cwd,
      status: this.#status,
      parentId: this.parentId,
      rootId: this.rootId,
      depth: this.depth,
      createdAt: this.createdAt,
      lastActivityAt: this.#lastActivityAt,
      endedAt: this.#endedAt,
      turn: this.#turn,
      turnStartedAt: this.#turnStartedAt,
      queued: this.#queue.length,
      settled: this.#status === "idle" && this.#queue.length === 0,
      lastSeq: this.#log.lastSeq,
      lastEvent: this.#lastEvent ? { ...this.#lastEvent } : null,
      pendingPermission: pending
        ? toPermissionView(pending.requestId, pending.requestedAt, pending.request)
        : null,
      lastStopReason: this.#lastStopReason,
      agentSessionId: this.#agentSessionId,
      processId: this.#child?.pid ?? null,
      exit: this.#exit,
      permissionPolicy: this.#permissionPolicy,
      modes: this.#modes
        ? {
            currentModeId: this.#modes.currentModeId,
            availableModes: this.#modes.availableModes.map((mode) => ({ ...mode })),
          }
        : null,
      configOptions: this.#configOptions
        ? this.#configOptions.map((option) => ({
            ...option,
            values: option.values.map((value) => ({ ...value })),
          }))
        : null,
      usage: this.#usage
        ? {
            ...this.#usage,
            cost: this.#usage.cost ? { ...this.#usage.cost } : null,
          }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // prompt queue
  // -------------------------------------------------------------------------

  async send(
    text: string,
    wait: boolean,
    timeoutMs: number,
    from = "operator",
    options: { messageId?: string; idempotencyKey?: string } = {},
  ): Promise<SendResult> {
    if (this.isTerminal || this.#closing) {
      throw new HlaoError(
        "session_closed",
        `session ${this.id} is ${this.isTerminal ? this.#status : "closing"}`,
      );
    }
    if (!this.#ready || !this.#conn || !this.#agentSessionId) {
      throw new HlaoError("session_not_ready", `session ${this.id} is still starting`);
    }
    if (text.length === 0 || text.length > MAX_PROMPT_CHARS) {
      throw new HlaoError("bad_request", "prompt text is empty or too long");
    }

    // A session is inside its own turn when it runs this command. Waiting for
    // a message queued behind that same turn would deadlock until the wait
    // timeout; reject it and name the deferred form instead.
    if (
      wait &&
      !this.#cancelling &&
      from === this.id &&
      (this.#active !== null ||
        this.#status === "busy" ||
        this.#status === "waiting_permission")
    ) {
      throw new HlaoError(
        "bad_request",
        "cannot wait for a self-message behind your own turn; send it without --wait to run it after this turn, or wait on another session",
      );
    }

    // A retry must not be rejected by the queue its own first attempt filled.
    this.#pruneIdempotency();
    const key = options.idempotencyKey;
    if (key !== undefined) {
      const existing = this.#idempotency.get(key);
      if (existing !== undefined) {
        const active = this.#active?.id === existing.messageId;
        const queued =
          active ||
          this.#queue.some((item) => item.id === existing.messageId);
        return {
          messageId: existing.messageId,
          queued,
          turn: active ? this.#active!.turn : null,
          completed: false,
          timedOut: false,
          duplicate: true,
        };
      }
    }

    if (this.#queue.length >= MAX_QUEUED_PROMPTS) {
      throw new HlaoError(
        "bad_request",
        `session ${this.id} has ${MAX_QUEUED_PROMPTS} prompts queued; wait or cancel first`,
      );
    }

    const messageId = options.messageId ?? generateMessageId();
    if (
      this.#active?.id === messageId ||
      this.#queue.some((item) => item.id === messageId)
    ) {
      throw new HlaoError(
        "bad_request",
        `message id "${messageId}" is already in this session`,
      );
    }

    const item = createQueueItem(messageId, text, from);
    const queuedAhead = this.#active !== null;
    item.wasQueued = queuedAhead;
    this.#queue.push(item);
    if (key !== undefined) {
      this.#idempotency.set(key, { messageId, at: Date.now() });
      this.#pruneIdempotency();
    }
    if (queuedAhead) {
      this.#emit("prompt.queued", {
        messageId,
        position: this.#queue.length + (this.#active ? 1 : 0),
        textPreview: previewText(text),
        textLength: text.length,
        from,
      });
    }
    void this.#pump();

    if (!wait) {
      return {
        messageId,
        queued: queuedAhead,
        turn: item.turn,
        completed: false,
        timedOut: false,
      };
    }

    const raced = await raceWithTimeout(item.promise, timeoutMs);
    if (raced.timedOut) {
      // The turn keeps running; report what it has produced so far.
      const partial = this.#active === item ? this.#turnText : "";
      return {
        messageId,
        queued: queuedAhead,
        turn: item.turn,
        completed: false,
        timedOut: true,
        outcome: "timed_out",
        ...(partial.length > 0 ? { text: partial } : {}),
      };
    }

    const completion = raced.value;
    if (!completion.ok) {
      throw new HlaoError(
        (completion.error?.code as HlaoError["code"]) ?? "session_failed",
        completion.error?.message ?? "prompt failed",
      );
    }
    return {
      messageId,
      queued: queuedAhead,
      turn: completion.turn,
      completed: true,
      timedOut: false,
      stopReason: completion.stopReason,
      text: completion.text,
      outcome:
        completion.stopReason === "cancelled" ? "cancelled" : "completed",
    };
  }

  #pruneIdempotency(): void {
    const cutoff = Date.now() - 60 * 60 * 1_000;
    for (const [key, entry] of this.#idempotency) {
      if (entry.at < cutoff) this.#idempotency.delete(key);
    }
    while (this.#idempotency.size > 256) {
      const oldest = this.#idempotency.keys().next().value;
      if (oldest === undefined) break;
      this.#idempotency.delete(oldest);
    }
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (
        !this.#active &&
        this.#queue.length > 0 &&
        !this.isTerminal &&
        !this.#closing
      ) {
        const item = this.#queue.shift()!;
        if (item.settled) continue;
        this.#turn += 1;
        item.turn = this.#turn;
        this.#active = item;
        this.#turnText = "";
        this.#lastMessageId = null;
        this.#status = "busy";
        this.#turnStartedAt = nowIso();
        this.#lastStopReason = null;
        const waitedMs = Date.now() - item.enqueuedAt;
        const injectSkill = this.#skillEnabled && !this.#skillInjected;
        this.#emit(
          "prompt.sent",
          {
            messageId: item.id,
            text: item.text,
            from: item.from,
            wasQueued: item.wasQueued,
            waitedMs,
            queuedMs: waitedMs,
            ...(injectSkill
              ? {
                  injected: {
                    skill: VERSION,
                    path: this.#skillPath,
                    blocks: 2,
                  },
                }
              : {}),
          },
          item.turn,
        );
        this.#emit("turn.started", { turn: item.turn }, item.turn);
        await this.#runPrompt(item, injectSkill);
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #runPrompt(item: QueueItem, injectSkill: boolean): Promise<void> {
    const turn = item.turn!;
    try {
      const blocks: ContentBlock[] = [];
      if (injectSkill) {
        blocks.push({
          type: "text",
          text: skillPointer(this.#skillPath),
        });
      }
      blocks.push({ type: "text", text: item.text });
      const response = await this.#conn!.agent.request("session/prompt", {
        sessionId: this.#agentSessionId!,
        prompt: blocks,
      });
      // Mark the pointer delivered only after the prompt request succeeds; a
      // failed request leaves it to be sent with the next prompt.
      if (injectSkill) this.#skillInjected = true;
      this.#finishTurn(item, response.stopReason as StopReason);
    } catch (error) {
      if (this.#closing || this.#cancelling) {
        const stopReason: StopReason = "cancelled";
        this.#cancelling = false;
        this.#lastStopReason = stopReason;
        this.#clearPending("cancel");
        this.#settleItem(item, {
          ok: true,
          turn,
          stopReason,
          text: this.#turnText,
        });
        this.#emit(
          "turn.ended",
          { turn, stopReason, textLength: this.#turnText.length },
          turn,
        );
      } else if (this.isTerminal) {
        this.#settleItem(item, {
          ok: false,
          turn,
          text: this.#turnText,
          error: {
            code: "session_failed",
            message: this.#startupError?.message ?? "session ended during the turn",
          },
        });
      } else {
        const message = describeError(error);
        this.#clearPending("prompt-failed");
        this.#emit("error", { message, phase: "prompt" }, turn);
        this.#settleItem(item, {
          ok: false,
          turn,
          text: this.#turnText,
          error: { code: "session_failed", message },
        });
      }
    } finally {
      this.#active = null;
      this.#turnText = "";
      if (!this.isTerminal) {
        this.#status = this.#pending ? "waiting_permission" : "idle";
        if (!this.#pending) this.#turnStartedAt = null;
        this.#changed();
        void this.#pump();
      }
    }
  }

  #finishTurn(item: QueueItem, stopReason: StopReason): void {
    const turn = item.turn!;
    const text = this.#turnText;
    this.#cancelling = false;
    this.#clearPending("turn-ended");
    this.#lastStopReason = stopReason;
    this.#emit("turn.ended", { turn, stopReason, textLength: text.length }, turn);
    this.#settleItem(item, { ok: true, turn, stopReason, text });
  }

  #settleItem(item: QueueItem, completion: PromptCompletion): void {
    if (item.settled) return;
    item.settled = true;
    item.settle(completion);
  }

  #discardQueue(reason: "cancel" | "close" | "failed", by: string): number {
    const items = this.#queue.splice(0);
    for (const item of items) {
      this.#emit("prompt.discarded", {
        messageId: item.id,
        text: item.text,
        textPreview: previewText(item.text),
        from: item.from,
        by,
        queuedMs: Date.now() - item.enqueuedAt,
        reason,
      });
      this.#settleItem(item, {
        ok: true,
        turn: null,
        stopReason: "cancelled",
        text: "",
        cancelledBeforeStart: true,
      });
    }
    if (items.length > 0) this.#changed();
    return items.length;
  }

  // -------------------------------------------------------------------------
  // reads and waits
  // -------------------------------------------------------------------------

  read(options: ReadOptions): ReadResult {
    return this.#log.read({
      since: options.since,
      before: options.before,
      limit: options.limit ?? 100,
      raw: options.raw ?? false,
      types: options.types,
      turn: options.turn,
      grep: options.grep,
    });
  }

  waitFor(
    until: WaitUntil,
    since: number | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    types?: EventType[],
    grep?: string,
  ): Promise<WaitResult> {
    const startedAt = Date.now();
    let changeCursor = until === "change" ? (since ?? this.#log.lastSeq) : (since ?? 0);

    return new Promise<WaitResult>((resolve) => {
      let finished = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (satisfied: boolean, reason: WaitUntil | "timeout"): void => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        this.#waiters.delete(check);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve({ satisfied, reason, waitedMs: Date.now() - startedAt });
      };

      const check = (): void => {
        switch (until) {
          case "idle":
            if (this.#status === "idle") finish(true, "idle");
            else if (this.isTerminal) finish(false, "exit");
            return;
          case "settled":
            // Completion: a terminal session is done, a pending permission is
            // an actionable stop, and idle alone is not enough while the queue
            // still has work.
            if (this.isTerminal) finish(true, "exit");
            else if (this.#pending) finish(true, "permission");
            else if (this.#status === "idle" && this.#queue.length === 0) {
              finish(true, "idle");
            }
            return;
          case "permission":
            if (this.#pending) finish(true, "permission");
            else if (this.isTerminal) finish(false, "exit");
            return;
          case "exit":
            if (this.isTerminal) finish(true, "exit");
            return;
          case "change": {
            const page = this.#log.read({
              since: changeCursor,
              limit: 1,
              raw: false,
              types,
              grep,
            });
            if (page.events.length > 0) {
              finish(true, "change");
              return;
            }
            // Advance past scanned non-matching events; the corrected cursor
            // is the last scanned seq, so a filtered waiter does not rescan.
            changeCursor = page.nextSeq;
            if (this.isTerminal) finish(false, "exit");
            return;
          }
        }
      };

      const onAbort = (): void => finish(false, "timeout");

      if (signal?.aborted) {
        finish(false, "timeout");
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.add(check);
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
        timer.unref?.();
      }
      check();
    });
  }

  // -------------------------------------------------------------------------
  // cancel, close, permissions
  // -------------------------------------------------------------------------

  async cancel(
    keepQueue = false,
    by = "operator",
  ): Promise<{ discarded: number }> {
    if (this.isTerminal) return { discarded: 0 };
    const discarded = keepQueue ? 0 : this.#discardQueue("cancel", by);
    this.#clearPending("cancel", by);
    if (this.#active) {
      this.#cancelling = true;
      this.#emit("cancel.requested", {
        turn: this.#active.turn,
        by,
        keepQueue,
      });
      try {
        await this.#conn?.agent.notify("session/cancel", {
          sessionId: this.#agentSessionId!,
        });
      } catch (error) {
        this.#emit("error", { message: describeError(error), phase: "cancel" });
      }
    }
    return { discarded };
  }

  async close(
    force = false,
    by = "operator",
  ): Promise<{ killed: boolean; wasTerminal: boolean }> {
    if (this.isTerminal) return { killed: false, wasTerminal: true };
    this.#closing = true;
    this.#closingBy = by;
    this.#discardQueue("close", by);
    this.#clearPending("close", by);

    if (!force && this.#conn && this.#agentSessionId) {
      const canClose = this.#caps.sessionCapabilities?.close !== undefined &&
        this.#caps.sessionCapabilities?.close !== null;
      if (canClose) {
        try {
          await withTimeout(
            this.#conn.agent.request("session/close", {
              sessionId: this.#agentSessionId,
            }),
            3_000,
            "session/close",
          );
        } catch {
          // The adapter may not implement close despite advertising it; kill below.
        }
      }
    }

    const child = this.#child;
    let killed = false;

    // On Windows a forced close must take the tree before the connection is
    // closed: closing stdio can let the adapter exit first, orphaning tools.
    if (
      force &&
      process.platform === "win32" &&
      child &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      killed = true;
      killProcessTree(child);
    }

    try {
      this.#conn?.close();
    } catch {
      // Already closed.
    }
    // Ending the ACP stream should end the adapter's stdin; well-behaved
    // adapters exit on EOF. The kill below is only the fallback.
    try {
      this.#child?.stdin?.end();
    } catch {
      // Already ended.
    }

    if (child && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") {
        if (!force) {
          const exited = await waitForExit(child, 1_500);
          if (!exited) {
            killed = true;
            killProcessTree(child);
            await waitForExit(child, 3_000);
          }
        } else {
          await waitForExit(child, 3_000);
        }
      } else {
        // The adapter leads its process group; signal the group so tools it
        // spawned do not outlive it.
        if (force) killed = true;
        signalProcessGroup(child, force ? "SIGKILL" : "SIGTERM");
        const exited = await waitForExit(child, force ? 2_000 : 5_000);
        if (!exited) {
          killed = true;
          signalProcessGroup(child, "SIGKILL");
          await waitForExit(child, 2_000);
        }
      }
    }

    this.#finalize("closed", undefined, by);
    return { killed, wasTerminal: false };
  }

  permit(
    optionId?: string,
    requestId?: string,
    always = false,
    by = "operator",
  ): { requestId: string; optionId: string } {
    const pending = this.#pending;
    if (!pending) {
      throw new HlaoError("no_pending_permission", `session ${this.id} has no pending permission`);
    }
    if (requestId !== undefined && requestId !== pending.requestId) {
      throw new HlaoError(
        "no_pending_permission",
        `no pending permission with request id ${requestId}`,
        { requestId: pending.requestId },
      );
    }

    let chosen: PermissionOption | undefined;
    if (optionId !== undefined) {
      chosen = pending.request.options.find((option) => option.optionId === optionId);
      if (!chosen) {
        throw new HlaoError("bad_option", `permission option "${optionId}" was not offered`, {
          options: pending.request.options.map((option) => ({
            optionId: option.optionId,
            name: option.name,
            kind: option.kind,
          })),
        });
      }
    } else if (always) {
      chosen =
        pending.request.options.find((option) => option.kind === "allow_always") ??
        pickAllowOption(pending.request.options);
      if (!chosen) {
        throw new HlaoError(
          "bad_option",
          "this permission request offers no allow option; pass --option explicitly",
          {
            options: pending.request.options.map((option) => ({
              optionId: option.optionId,
              name: option.name,
              kind: option.kind,
            })),
          },
        );
      }
    } else {
      chosen = pickAllowOption(pending.request.options);
      if (!chosen) {
        throw new HlaoError(
          "bad_option",
          "this permission request offers no allow option; pass --option explicitly",
          {
            options: pending.request.options.map((option) => ({
              optionId: option.optionId,
              name: option.name,
              kind: option.kind,
            })),
          },
        );
      }
    }

    if (always) {
      this.#changePolicy("allow", by);
    }
    this.#resolvePending(chosen, by);
    return { requestId: pending.requestId, optionId: chosen.optionId };
  }

  /** Answer the parked request and wake the turn. */
  #resolvePending(chosen: PermissionOption, by: string): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    if (!this.isTerminal) {
      this.#status = this.#active ? "busy" : "idle";
    }
    this.#emit("permission.resolved", {
      requestId: pending.requestId,
      optionId: chosen.optionId,
      optionName: chosen.name,
      by,
    });
    pending.resolve(selectedResponse(chosen.optionId));
    this.#changed();
  }

  /** Changes the operator-facing label. The id and env identity do not change. */
  setName(name: string | null, by = "operator"): void {
    if (this.isTerminal || this.#closing) {
      throw new HlaoError("session_closed", `session ${this.id} is ${this.isTerminal ? this.#status : "closing"}`);
    }
    if (name !== null && name.trim().length === 0) {
      throw new HlaoError("bad_request", "a session name must not be empty; pass null to clear");
    }
    this.#name = name;
    this.#emit("session.renamed", { name, by });
    this.#changed();
  }

  /** Reads or writes the live HLAO permission policy. */
  setPolicy(policy: PermissionPolicy, by = "operator"): void {
    if (this.isTerminal || this.#closing) {
      throw new HlaoError("session_closed", `session ${this.id} is ${this.isTerminal ? this.#status : "closing"}`);
    }
    this.#changePolicy(policy, by);

    // A policy change is also the answer to an existing request. `ask` leaves
    // it parked; `allow`/`deny` answer it when the provider offered a matching
    // option.
    const pending = this.#pending;
    if (!pending || policy === "ask") return;
    if (policy === "allow") {
      const allow = pickAllowOption(pending.request.options);
      if (allow) this.#resolvePending(allow, by);
      return;
    }
    const reject =
      pending.request.options.find((option) => option.kind === "reject_once") ??
      pending.request.options.find((option) => option.kind === "reject_always");
    if (reject) this.#resolvePending(reject, by);
  }

  #changePolicy(policy: PermissionPolicy, by: string): void {
    if (this.#permissionPolicy === policy) return;
    this.#permissionPolicy = policy;
    this.#emit("policy.changed", { permissionPolicy: policy, by });
    this.#changed();
  }

  /** Switches a provider-native mode when the backend advertises modes. */
  async setMode(modeId: string, by = "operator"): Promise<SessionModes> {
    if (this.isTerminal || this.#closing) {
      throw new HlaoError("session_closed", `session ${this.id} is ${this.isTerminal ? this.#status : "closing"}`);
    }
    if (!this.#ready || !this.#conn || !this.#agentSessionId) {
      throw new HlaoError("session_not_ready", `session ${this.id} is still starting`);
    }
    if (!this.#modes) {
      throw new HlaoError(
        "bad_request",
        `backend "${this.backend}" does not advertise session modes`,
      );
    }
    if (!this.#modes.availableModes.some((mode) => mode.id === modeId)) {
      throw new HlaoError("bad_option", `mode "${modeId}" is not available`, {
        options: this.#modes.availableModes,
      });
    }
    if (this.#modes.currentModeId !== modeId) {
      await this.#conn.agent.request("session/set_mode", {
        sessionId: this.#agentSessionId,
        modeId,
      });
      this.#modes = { ...this.#modes, currentModeId: modeId };
      this.#emit("mode", { currentModeId: modeId, by });
      this.#changed();
    }
    return this.#modes;
  }

  /** Sets a provider-advertised session config option. */
  async setConfigOption(
    configId: string,
    value: string | boolean,
    by = "operator",
  ): Promise<SessionConfigOptionView[]> {
    if (this.isTerminal || this.#closing) {
      throw new HlaoError("session_closed", `session ${this.id} is ${this.isTerminal ? this.#status : "closing"}`);
    }
    if (!this.#ready || !this.#conn || !this.#agentSessionId) {
      throw new HlaoError("session_not_ready", `session ${this.id} is still starting`);
    }
    const options = this.#configOptions;
    const option = options?.find((candidate) => candidate.id === configId);
    if (!option) {
      throw new HlaoError(
        "bad_request",
        `config option "${configId}" is not advertised` +
          (options && options.length > 0
            ? `; available: ${options.map((candidate) => candidate.id).join(", ")}`
            : ""),
      );
    }
    let resolvedValue: string | boolean = value;
    if (option.type === "boolean") {
      if (typeof value === "string" && (value === "true" || value === "false")) {
        resolvedValue = value === "true";
      }
      if (typeof resolvedValue !== "boolean") {
        throw new HlaoError(
          "bad_request",
          `config option "${configId}" takes true or false`,
        );
      }
    } else {
      if (typeof value !== "string") {
        throw new HlaoError(
          "bad_request",
          `config option "${configId}" takes a value id`,
        );
      }
      if (!option.values.some((candidate) => candidate.value === value)) {
        throw new HlaoError(
          "bad_option",
          `value "${value}" is not offered by config option "${configId}"`,
          {
            options: option.values.map((candidate) => ({
              optionId: candidate.value,
              name: candidate.name,
              kind: "value",
            })),
          },
        );
      }
    }

    const response = await this.#conn.agent.request(
      "session/set_config_option",
      typeof resolvedValue === "boolean"
        ? {
            sessionId: this.#agentSessionId,
            configId,
            type: "boolean" as const,
            value: resolvedValue,
          }
        : { sessionId: this.#agentSessionId, configId, value: resolvedValue },
    );
    this.#configOptions = toConfigOptionViews(response.configOptions);
    this.#emit("config", { configOptions: this.#configOptions, by });
    this.#changed();
    return this.#configOptions ?? [];
  }

  /** Selects a value from the option whose category is `model`. */
  async setModel(model: string, by = "operator"): Promise<SessionConfigOptionView[]> {
    const option = this.#configOptions?.find(
      (candidate) => candidate.category === "model",
    );
    if (!option) {
      throw new HlaoError(
        "bad_request",
        `backend "${this.backend}" does not advertise a model option`,
      );
    }
    return await this.setConfigOption(option.id, model, by);
  }

  queueView(): { active: QueueItemView | null; queue: QueueItemView[] } {
    return {
      active: this.#active ? queueItemView(this.#active, null) : null,
      queue: this.#queue.map((item, index) => queueItemView(item, index + 1)),
    };
  }

  dropQueued(
    target: { position: number } | { messageId: string },
    by = "operator",
  ): { dropped: QueueItemView; discarded: number } {
    let index: number;
    if ("position" in target) {
      index = target.position - 1;
      if (index < 0 || index >= this.#queue.length) {
        throw new HlaoError(
          "bad_request",
          `queue position ${target.position} is out of range (1..${this.#queue.length})`,
        );
      }
    } else {
      index = this.#queue.findIndex((item) => item.id === target.messageId);
      if (index < 0) {
        throw new HlaoError(
          "bad_request",
          `message "${target.messageId}" is not queued in session ${this.id}`,
        );
      }
    }
    const position = index + 1;
    const [item] = this.#queue.splice(index, 1);
    if (!item) {
      throw new HlaoError("bad_request", `queue position ${position} is empty`);
    }
    this.#emit("prompt.discarded", {
      messageId: item.id,
      text: item.text,
      textPreview: previewText(item.text),
      from: item.from,
      by,
      queuedMs: Date.now() - item.enqueuedAt,
      reason: "dropped",
      position,
    });
    this.#settleItem(item, {
      ok: true,
      turn: null,
      stopReason: "cancelled",
      text: "",
      cancelledBeforeStart: true,
    });
    this.#changed();
    return { dropped: queueItemView(item, position), discarded: 1 };
  }

  #onPermission(
    params: RequestPermissionRequest,
    requestId: string,
  ): Promise<RequestPermissionResponse> {
    if (this.isTerminal || this.#closing || this.#cancelling) {
      return Promise.resolve(cancelledResponse());
    }
    // A permission request is meaningful only while a prompt turn is active.
    // A late request after a failed or finished turn must not resurrect a
    // waiting_permission state.
    if (!this.#active) {
      return Promise.resolve(cancelledResponse());
    }
    if (this.#pending) {
      this.#emit("error", {
        message: "a second permission request arrived while one was pending",
        requestId,
      });
      return Promise.resolve(cancelledResponse());
    }

    const auto = this.#permissionPolicy !== "ask";
    this.#emit("permission.requested", {
      requestId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "",
      kind: params.toolCall.kind ?? null,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      policy: this.#permissionPolicy,
      auto,
    });

    const policyChoice = chooseByPolicy(params.options, this.#permissionPolicy);
    if (policyChoice === "cancelled") {
      this.#emit("permission.resolved", {
        requestId,
        optionId: null,
        by: `policy:${this.#permissionPolicy}`,
        note: `no ${this.#permissionPolicy} option was offered; cancelled`,
      });
      return Promise.resolve(cancelledResponse());
    }
    if (policyChoice) {
      this.#emit("permission.resolved", {
        requestId,
        optionId: policyChoice.optionId,
        optionName: policyChoice.name,
        by: `policy:${this.#permissionPolicy}`,
      });
      return Promise.resolve(selectedResponse(policyChoice.optionId));
    }

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.#pending = { requestId, requestedAt: nowIso(), request: params, resolve };
      this.#status = "waiting_permission";
      this.#changed();
    });
  }

  #clearPending(reason: string, by = "system"): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    if (this.#status === "waiting_permission" && !this.isTerminal) {
      this.#status = this.#active ? "busy" : "idle";
    }
    this.#emit("permission.resolved", {
      requestId: pending.requestId,
      optionId: null,
      by,
      reason,
    });
    pending.resolve(cancelledResponse());
    this.#changed();
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async #start(): Promise<void> {
    this.#emit("session.created", {
      backend: this.backend,
      cwd: this.cwd,
      name: this.name,
      createdBy: this.#createdBy,
      mode: this.requestedMode,
      parentId: this.parentId,
      rootId: this.rootId,
      depth: this.depth,
      permissionPolicy: this.#permissionPolicy,
      envKeys: [
        ...new Set([
          ...Object.keys(this.#backendManifest.env),
          ...Object.keys(this.#env),
        ]),
      ].sort(),
    });

    const child = spawn(this.#backendManifest.command, this.#backendManifest.args, {
      cwd: this.cwd,
      env: this.#buildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // On POSIX the adapter leads its own process group so tools it starts can
      // be terminated with it. Windows already has taskkill /T.
      detached: process.platform !== "win32",
    });
    this.#child = child;
    this.#captureStderr(child);
    // A dying adapter can make writes fail with EPIPE; that is expected during
    // close and must not surface as an unhandled stream error.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});

    const spawnFailure = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        reject(
          new HlaoError("spawn_failed", `cannot start ${this.backend}: ${describeError(error)}`),
        );
      });
      child.once("exit", (code, signal) => {
        this.#exit = { code, signal };
        reject(
          new HlaoError(
            "spawn_failed",
            `adapter exited during startup (${signal ?? code ?? "unknown"})${this.#stderrSuffix()}`,
            { stderr: this.#stderrTail },
          ),
        );
      });
    });
    spawnFailure.catch(() => {
      // The failure may arrive after a successful start; the runtime handlers own it.
    });

    try {
      await Promise.race([
        new Promise<void>((resolve) => child.once("spawn", () => resolve())),
        spawnFailure,
      ]);

      child.once("error", (error) => {
        if (this.#ready) {
          this.#startupError = error;
          this.#finalize(
            this.#closing ? "closed" : "failed",
            new Error(`adapter process error: ${describeError(error)}`),
            this.#closing ? this.#closingBy ?? "system" : "system",
          );
        }
      });
      child.once("exit", (code, signal) => this.#onProcessExit(code, signal));

      await Promise.race([this.#initialize(), spawnFailure]);
    } catch (error) {
      const originalCode =
        error instanceof HlaoError ? error.code : undefined;
      this.#closing = true;
      try {
        this.#conn?.close();
      } catch {
        // Nothing to close.
      }
      if (child.exitCode === null && child.signalCode === null) {
        killProcessTree(child);
      }
      // Give the exit event a moment so a crash during startup is reported with
      // its code instead of only "connection closed".
      await waitForExit(child, 500);
      if (
        this.#exit === null &&
        (child.exitCode !== null || child.signalCode !== null)
      ) {
        this.#exit = { code: child.exitCode, signal: child.signalCode };
      }
      const message = `${this.backend} failed to start: ${describeError(error)}${this.#stderrSuffix()}`;
      this.#startupError = new Error(message);
      this.#finalize("failed", this.#startupError);
      throw new HlaoError("spawn_failed", message, {
        stderr: this.#stderrTail,
        ...(this.#exit ? { exit: this.#exit } : {}),
        ...(originalCode !== undefined ? { cause: originalCode } : {}),
      });
    }
  }

  async #initialize(): Promise<void> {
    const child = this.#child!;
    if (!child.stdout || !child.stdin) {
      throw new HlaoError("spawn_failed", "adapter stdio is unavailable");
    }

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );

    const app = client({ name: "hlao" })
      .onNotification("session/update", ({ params }) => {
        this.#onUpdate(params);
      })
      .onRequest("session/request_permission", ({ params, requestId }) =>
        this.#onPermission(params, String(requestId)),
      );

    this.#conn = app.connect(stream);
    this.#conn.closed.then(
      () => this.#onConnectionClosed(),
      (error) => this.#onConnectionClosed(error),
    );

    const init = await withTimeout(
      this.#conn.agent.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          session: {
            // Boolean config options are optional in ACP; advertising support
            // lets an adapter include them and accept boolean set requests.
            configOptions: { boolean: {} },
          },
        },
        clientInfo: { name: "hlao", version: VERSION },
      }),
      this.#config.startupTimeoutMs,
      "ACP initialize",
    );

    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new HlaoError(
        "spawn_failed",
        `${this.backend} speaks ACP v${init.protocolVersion}; HLAO requires v${ACP_PROTOCOL_VERSION}`,
      );
    }
    this.#caps = init.agentCapabilities ?? {};

    const created = await withTimeout(
      this.#conn.agent.request("session/new", {
        cwd: this.cwd,
        mcpServers: [],
      }),
      this.#config.startupTimeoutMs,
      "ACP session/new",
    );

    this.#agentSessionId = created.sessionId;
    if (created.modes) {
      this.#modes = {
        currentModeId: created.modes.currentModeId,
        availableModes: created.modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      };
    }
    this.#configOptions = toConfigOptionViews(created.configOptions);
    this.#ready = true;
    this.#status = "idle";
    this.#emit("session.initialized", {
      agentSessionId: created.sessionId,
      agentName: init.agentInfo?.name ?? null,
      agentVersion: init.agentInfo?.version ?? null,
      mode: this.#modes?.currentModeId ?? null,
      loadSession: Boolean(this.#caps.loadSession),
      listSessions: this.#caps.sessionCapabilities?.list !== undefined &&
        this.#caps.sessionCapabilities?.list !== null,
      closeSession: this.#caps.sessionCapabilities?.close !== undefined &&
        this.#caps.sessionCapabilities?.close !== null,
    });
    this.#changed();
  }

  #onUpdate(notification: SessionNotification): void {
    if (notification.sessionId !== this.#agentSessionId) return;
    const update = notification.update;
    if (update.sessionUpdate === "current_mode_update" && this.#modes) {
      this.#modes = { ...this.#modes, currentModeId: update.currentModeId };
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      const messageId = update.messageId ?? null;
      if (
        this.#turnText.length > 0 &&
        messageId !== null &&
        this.#lastMessageId !== null &&
        messageId !== this.#lastMessageId
      ) {
        this.#turnText += "\n";
      }
      if (messageId !== null) this.#lastMessageId = messageId;
    }
    const mapped = projectUpdate(update);
    if (
      mapped.type === "config" &&
      update.sessionUpdate === "config_option_update"
    ) {
      this.#configOptions = toConfigOptionViews(update.configOptions);
      mapped.data.configOptions = this.#configOptions;
      mapped.data.by = "agent";
    }
    if (
      mapped.type === "mode" &&
      update.sessionUpdate === "current_mode_update"
    ) {
      mapped.data.by = "agent";
    }
    if (mapped.textDelta) this.#turnText += mapped.textDelta;
    const event = this.#emit(
      mapped.type,
      { ...mapped.data, raw: notification.update },
      this.#active?.turn ?? null,
    );
    if (mapped.type === "tool.update" && event.data.status === "failed") {
      this.#lastActivityAt = nowIso();
    }
  }

  #onConnectionClosed(error?: unknown): void {
    if (this.isTerminal) return;
    if (this.#closing) {
      this.#finalize("closed", undefined, this.#closingBy ?? "system");
      return;
    }
    const reason = error ? describeError(error) : "ACP connection closed";
    this.#startupError = new Error(reason);
    this.#finalize("failed", new Error(reason));
    if (this.#child) killProcessTree(this.#child);
  }

  #onProcessExit(code: number | null, signal: string | null): void {
    this.#exit = { code, signal };
    if (this.isTerminal) return;
    if (this.#closing) {
      this.#finalize("closed", undefined, this.#closingBy ?? "system");
      return;
    }
    const detail = `adapter exited (${signal ?? code ?? "unknown"})${this.#stderrSuffix()}`;
    this.#startupError = new Error(detail);
    this.#finalize("failed", new Error(detail));
  }

  #finalize(
    status: "closed" | "failed",
    error?: Error,
    by = "system",
  ): void {
    if (this.isTerminal) return;
    this.#status = status;
    this.#endedAt = nowIso();
    this.#lastActivityAt = this.#endedAt;
    this.#turnStartedAt = null;

    const cancelledCompletion: PromptCompletion = {
      ok: status === "closed",
      turn: null,
      stopReason: status === "closed" ? "cancelled" : undefined,
      text: this.#turnText,
      error:
        status === "failed"
          ? {
              code: "session_failed",
              message: error?.message ?? "session failed",
            }
          : undefined,
    };

    this.#clearPending(status, by);

    if (this.#active) {
      const active = this.#active;
      this.#settleItem(active, { ...cancelledCompletion, turn: active.turn });
      this.#active = null;
    }
    for (const item of this.#queue.splice(0)) {
      this.#emit("prompt.discarded", {
        messageId: item.id,
        text: item.text,
        textPreview: previewText(item.text),
        from: item.from,
        by,
        queuedMs: Date.now() - item.enqueuedAt,
        reason: status === "closed" ? "close" : "failed",
      });
      this.#settleItem(item, cancelledCompletion);
    }

    this.#emit(status === "closed" ? "session.closed" : "session.failed", {
      message: error?.message ?? status,
      by,
      exit: this.#exit,
      stderr: this.#stderrTail,
    });
    this.#changed();

    if (status === "failed" && this.#child && this.#child.exitCode === null) {
      killProcessTree(this.#child);
    }
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  #buildEnv(): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("HLAO_")) base[key] = value;
    }
    return {
      ...base,
      ...this.#backendManifest.env,
      ...this.#env,
      HLAO_SESSION_ID: this.id,
      HLAO_ROOT_ID: this.rootId,
      HLAO_DEPTH: String(this.depth),
      HLAO_BACKEND: this.backend,
      HLAO_HOME: this.#home,
      HLAO_CLI: this.#cliPath,
      HLAO_SKILL: this.#skillPath,
      HLAO_SKILL_VERSION: this.#skillVersion,
      ...(this.name ? { HLAO_NAME: this.name } : {}),
      ...(this.parentId ? { HLAO_PARENT_ID: this.parentId } : {}),
    };
  }

  #captureStderr(child: ChildProcess): void {
    if (!child.stderr) return;
    let buffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("error", () => {});
    child.stderr.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        this.#recordStderr(line);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > 8_192) {
        this.#recordStderr(buffer);
        buffer = "";
      }
    });
    child.stderr.on("end", () => {
      if (buffer.trim().length > 0) this.#recordStderr(buffer);
      buffer = "";
    });
  }

  #recordStderr(line: string): void {
    const text = line.length > 2_048 ? `${line.slice(0, 2_048)}…` : line;
    if (text.trim().length === 0) return;
    this.#stderrTail.push(text);
    if (this.#stderrTail.length > 20) this.#stderrTail.shift();
    this.#logLine(`[${this.id}] ${text}`);
    this.#emit("stderr", { text });
  }

  #stderrSuffix(): string {
    const last = this.#stderrTail[this.#stderrTail.length - 1];
    return last ? ` — ${last}` : "";
  }

  #emit(type: EventType, data: Record<string, unknown>, turn?: number | null): EventView {
    this.#lastActivityAt = nowIso();
    const event = this.#log.append({ type, turn: turn ?? this.#active?.turn ?? null, data });
    this.#lastEvent = {
      type,
      title: eventTitle(type, event.data),
      at: event.at,
    };
    if (type === "usage") {
      const rawCost = data.cost;
      let cost: SessionUsageView["cost"] = null;
      if (rawCost !== null && typeof rawCost === "object") {
        const record = rawCost as Record<string, unknown>;
        if (typeof record.amount === "number" && Number.isFinite(record.amount)) {
          cost = {
            amount: record.amount,
            currency: typeof record.currency === "string" ? record.currency : "USD",
          };
        }
      }
      this.#usage = {
        used: typeof data.used === "number" ? data.used : 0,
        size: typeof data.size === "number" ? data.size : 0,
        cost,
        at: event.at,
      };
    }
    this.#notifyWaiters();
    return event;
  }

  #changed(): void {
    this.#notifyWaiters();
  }

  #notifyWaiters(): void {
    for (const waiter of [...this.#waiters]) {
      try {
        waiter();
      } catch {
        // A waiter must never break the session.
      }
    }
    for (const listener of [...this.#changeListeners]) {
      try {
        listener();
      } catch {
        // An observer must never break the session.
      }
    }
  }
}
