import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ClientConnection,
  ContentBlock,
  NewSessionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { assertAcpVersion, initializeParams } from "./acp.js";
import type { BackendManifest } from "./config.js";
import { HlaoError, describeError } from "./errors.js";
import { EventLog } from "./events.js";
import { generateMessageId } from "./ids.js";
import { nowIso } from "./time.js";
import { VERSION } from "./version.js";
import type {
  EventType,
  EventView,
  QueueItemView,
  SessionConfigOptionView,
  SessionModes,
  SessionStatus,
  SessionUsageView,
  SessionView,
  StopReason,
  WaitUntil,
} from "./protocol.js";
import { MAX_PROMPT_CHARS, isTerminalStatus } from "./protocol.js";
import { raceWithTimeout, withTimeout } from "./session/async.js";
import { isModeConfigOption } from "./session/config-options.js";
import { buildSessionEnv } from "./session/env.js";
import { PendingInputs } from "./session/pending-input.js";
import {
  killProcessTree,
  stopAdapterProcess,
  waitForExit,
} from "./session/process.js";
import {
  applyProviderState,
  checkContextPressure,
  createProviderState,
  type ProviderState,
} from "./session/provider-state.js";
import {
  eventTitle,
  firstPromptPreview,
  previewText,
  projectUpdate,
  queueItemView,
  skillPointer,
  toConfigOptionViews,
} from "./session/projection.js";
import {
  createQueueItem,
  type PromptCompletion,
  type QueueItem,
} from "./session/queue.js";
import { readPage } from "./session/read.js";
import { steeringSupported } from "./session/steering.js";
import type {
  ReadOptions,
  ReadResult,
  SendResult,
  SessionConfig,
  SpawnOptions,
  WaitResult,
} from "./session/types.js";
import { waitForSession, type WaitState } from "./session/waits.js";

export type { PromptCompletion } from "./session/queue.js";
export type {
  ReadOptions,
  ReadResult,
  SendResult,
  SessionConfig,
  SpawnOptions,
  WaitResult,
} from "./session/types.js";

const MAX_QUEUED_PROMPTS = 1_000;


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
  #resumeSessionId: string | null;
  #forkSessionId: string | null;
  /** Events emitted while `session/load` replays are marked as history. */
  #replaying = false;
  #caps: AgentCapabilities = {};
  /** The adapter advertises mid-turn injection through `_session/steering`. */
  #steeringSupported = false;
  /** Message ids injected into the current turn, for duplicate `pending`. */
  #steeredIds = new Set<string>();
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
  #lastStopReason: StopReason | null = null;
  #usage: SessionUsageView | null = null;
  /** The provider's latest compaction, plan, title, and pressure notices. */
  #provider: ProviderState = createProviderState();
  #firstPrompt: string | null = null;
  #agentName: string | null = null;
  #agentVersion: string | null = null;
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
  /** The bounded permission FIFO and parked elicitation, with their deadline. */
  #pendingInputs: PendingInputs;
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
    this.#resumeSessionId = options.resumeSessionId ?? null;
    this.#forkSessionId = options.forkSessionId ?? null;
    this.parentId = options.parentId;
    this.rootId = options.rootId;
    this.depth = options.depth;
    this.createdAt = nowIso();
    this.requestedMode = options.requestedMode ?? null;
    this.#lastActivityAt = this.createdAt;
    this.#config = options.config;
    this.#backendManifest = options.backend;
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
    this.#pendingInputs = new PendingInputs(
      options.id,
      {
        permissionTimeoutMs: options.permissionTimeoutMs,
        maxPermissions: options.maxPendingPermissions,
      },
      {
        isTerminal: () => this.isTerminal,
        isClosing: () => this.#closing,
        isCancelling: () => this.#cancelling,
        hasActiveTurn: () => this.#active !== null,
        block: () => {
          this.#status = "waiting_permission";
          this.#changed();
        },
        refreshStatus: () => this.#refreshInputStatus(),
        refreshStatusIfWaiting: () => {
          if (this.#status === "waiting_permission") this.#refreshInputStatus();
        },
        emit: (type, data) => {
          this.#emit(type, data);
        },
        changed: () => this.#changed(),
      },
    );
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

  /** Operator input of either kind blocks the session the same way. */
  get #awaitingInput(): boolean {
    return this.#pendingInputs.awaiting;
  }

  view(): SessionView {
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
      pendingPermissions: this.#pendingInputs.permissionViews(),
      pendingElicitation: this.#pendingInputs.elicitationView(),
      lastStopReason: this.#lastStopReason,
      agentSessionId: this.#agentSessionId,
      forkedFrom: this.#forkSessionId,
      processId: this.#child?.pid ?? null,
      exit: this.#exit,
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
      compaction: this.#provider.compaction
        ? { ...this.#provider.compaction }
        : null,
      plan: this.#provider.plan
        ? {
            ...this.#provider.plan,
            ...(this.#provider.plan.entries
              ? {
                  entries: this.#provider.plan.entries.map((entry) => ({
                    ...entry,
                  })),
                }
              : {}),
          }
        : null,
      title: this.#provider.title,
      firstPrompt: this.#firstPrompt,
      agentName: this.#agentName,
      agentVersion: this.#agentVersion,
      steeringSupported: this.#steeringSupported,
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
    options: { messageId?: string; idempotencyKey?: string; steer?: boolean } = {},
  ): Promise<SendResult> {
    this.#assertOpen();
    this.#assertReady();
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
        const pending =
          active ||
          this.#steeredIds.has(existing.messageId) ||
          this.#queue.some((item) => item.id === existing.messageId);
        return {
          messageId: existing.messageId,
          // This retry enqueued nothing. `pending` describes the original
          // message, so a consumer cannot mistake a duplicate for new work.
          queued: false,
          pending,
          turn: active ? this.#active!.turn : null,
          completed: false,
          timedOut: false,
          duplicate: true,
          ...(this.#steeredIds.has(existing.messageId) ? { steered: true } : {}),
        };
      }
    }

    const messageId = options.messageId ?? generateMessageId();
    if (
      this.#active?.id === messageId ||
      this.#steeredIds.has(messageId) ||
      this.#queue.some((item) => item.id === messageId)
    ) {
      throw new HlaoError(
        "bad_request",
        `message id "${messageId}" is already in this session`,
      );
    }

    // Steering is the caller's choice; it is only attempted when the target is
    // actually mid-turn and the adapter advertised the extension. A null result
    // means "queue it", which is also the idle path.
    if (options.steer === true) {
      const steered = await this.#steer(messageId, text, from, wait, timeoutMs);
      if (steered !== null) {
        if (key !== undefined) {
          this.#idempotency.set(key, { messageId, at: Date.now() });
          this.#pruneIdempotency();
        }
        return steered;
      }
    }

    if (this.#queue.length >= MAX_QUEUED_PROMPTS) {
      throw new HlaoError(
        "bad_request",
        `session ${this.id} has ${MAX_QUEUED_PROMPTS} prompts queued; wait or cancel first`,
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

  /**
   * Inject a prompt into the turn that is already running (ACP
   * `_session/steering`). Returns null when the turn ended in the gap or the
   * adapter cannot steer; the caller then takes the ordinary queue path.
   *
   * `_meta.steering.idleBehavior: "promptRequired"` matters: without it a race
   * where the turn ends first makes the adapter start a detached turn that
   * HLAO neither tracks nor settles.
   */
  async #steer(
    messageId: string,
    text: string,
    from: string,
    wait: boolean,
    timeoutMs: number,
  ): Promise<SendResult | null> {
    const active = this.#active;
    // A self-send is a deferred next turn by contract. Injecting it into the
    // turn that issued it would change that and can close a wait cycle.
    if (
      active === null ||
      !this.#steeringSupported ||
      this.#cancelling ||
      from === this.id
    ) {
      return null;
    }

    let response: { outcome?: string };
    try {
      response = await this.#conn!.agent.request<{ outcome?: string }>(
        "_session/steering",
        {
          sessionId: this.#agentSessionId!,
          prompt: [{ type: "text", text }],
          _meta: { steering: { idleBehavior: "promptRequired" } },
        },
      );
    } catch (error) {
      if ((error as { code?: number }).code === -32601) {
        // Advertised but not implemented: stop trying for this session.
        this.#steeringSupported = false;
      }
      this.#logLine(
        `session ${this.id}: steering failed (${describeError(error)}); queued instead`,
      );
      return null;
    }

    if (response?.outcome === "startedNewTurn") {
      // An adapter without the idleBehavior opt-in delivered the prompt as its
      // own detached turn. Record the delivery, but HLAO cannot settle it.
      this.#steeredIds.add(messageId);
      this.#emit(
        "prompt.steered",
        {
          messageId,
          text,
          textPreview: previewText(text),
          textLength: text.length,
          from,
        },
        null,
      );
      return {
        messageId,
        queued: false,
        steered: true,
        turn: null,
        completed: false,
        timedOut: false,
      };
    }
    if (response?.outcome !== "injected") {
      // promptRequired: the turn finished before the injection landed.
      return null;
    }

    const turn = active.turn;
    this.#steeredIds.add(messageId);
    this.#emit(
      "prompt.steered",
      {
        messageId,
        text,
        textPreview: previewText(text),
        textLength: text.length,
        from,
      },
      turn,
    );

    if (!wait) {
      return {
        messageId,
        queued: false,
        steered: true,
        turn,
        completed: false,
        timedOut: false,
      };
    }

    // A steered message has no turn of its own: it joins the running turn, so
    // waiting means waiting for that turn to settle.
    const raced = await raceWithTimeout(active.promise, timeoutMs);
    if (raced.timedOut) {
      const partial = this.#active === active ? this.#turnText : "";
      return {
        messageId,
        queued: false,
        steered: true,
        turn,
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
      queued: false,
      steered: true,
      turn: completion.turn ?? turn,
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
        this.#steeredIds.clear();
        this.#turn += 1;
        item.turn = this.#turn;
        this.#active = item;
        this.#turnText = "";
        this.#lastMessageId = null;
        this.#status = "busy";
        this.#turnStartedAt = nowIso();
        this.#lastStopReason = null;
        if (this.#firstPrompt === null) {
          this.#firstPrompt = firstPromptPreview(item.text);
        }
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
        this.#pendingInputs.clearAll("cancel");
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
        this.#pendingInputs.clearAll("prompt-failed");
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
      // Steered ids belong to the turn that just ended. A steer response that
      // lands after this clear is stale; the next #pump clears it again.
      this.#steeredIds.clear();
      if (!this.isTerminal) {
        this.#status = this.#awaitingInput ? "waiting_permission" : "idle";
        if (!this.#awaitingInput) this.#turnStartedAt = null;
        this.#changed();
        void this.#pump();
      }
    }
  }

  #finishTurn(item: QueueItem, stopReason: StopReason): void {
    const turn = item.turn!;
    const text = this.#turnText;
    this.#cancelling = false;
    this.#pendingInputs.clearAll("turn-ended");
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
    return readPage(this.#log, options);
  }

  waitFor(
    until: WaitUntil,
    since: number | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    types?: EventType[],
    grep?: string,
  ): Promise<WaitResult> {
    return waitForSession(
      {
        state: () => this.#waitState(),
        lastSeq: this.#log.lastSeq,
        readChange: (cursor, filterTypes, filterGrep) => {
          const page = this.#log.read({
            since: cursor,
            limit: 1,
            raw: false,
            types: filterTypes,
            grep: filterGrep,
          });
          return { events: page.events, nextSeq: page.nextSeq };
        },
        addWaiter: (check) => {
          this.#waiters.add(check);
          return () => {
            this.#waiters.delete(check);
          };
        },
      },
      until,
      since,
      timeoutMs,
      signal,
      types,
      grep,
    );
  }

  #waitState(): WaitState {
    return {
      status: this.#status,
      queued: this.#queue.length,
      awaitingInput: this.#awaitingInput,
      terminal: this.isTerminal,
    };
  }

  // cancel, close, permissions
  // -------------------------------------------------------------------------

  async cancel(
    keepQueue = false,
    by = "operator",
  ): Promise<{ discarded: number }> {
    if (this.isTerminal) return { discarded: 0 };
    const discarded = keepQueue ? 0 : this.#discardQueue("cancel", by);
    this.#pendingInputs.clearAll("cancel", by);
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
    this.#pendingInputs.clearAll("close", by);

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

    if (child) {
      killed = (await stopAdapterProcess(child, force)) || killed;
    }

    this.#finalize("closed", undefined, by);
    return { killed, wasTerminal: false };
  }

  /** Answer one pending request with the provider's own option id. */
  permit(
    optionId: string,
    requestId?: string,
    by = "operator",
  ): { requestId: string; optionId: string } {
    return this.#pendingInputs.permit(optionId, requestId, by);
  }

  /** Recompute the blocked status from every pending input, not just one. */
  #refreshInputStatus(): void {
    if (this.isTerminal) return;
    this.#status = this.#awaitingInput
      ? "waiting_permission"
      : this.#active
        ? "busy"
        : "idle";
  }

  /** Changes the operator-facing label. The id and env identity do not change. */
  setName(name: string | null, by = "operator"): void {
    this.#assertOpen();
    if (name !== null && name.trim().length === 0) {
      throw new HlaoError("bad_request", "a session name must not be empty; pass null to clear");
    }
    this.#name = name;
    this.#emit("session.renamed", { name, by });
    this.#changed();
  }

  /** Switches a provider-native mode when the backend advertises modes. */
  async setMode(modeId: string, by = "operator"): Promise<SessionModes> {
    this.#assertOpen();
    const { conn, agentSessionId } = this.#assertReady();
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
      await conn.agent.request("session/set_mode", {
        sessionId: agentSessionId,
        modeId,
      });
      this.#modes = { ...this.#modes, currentModeId: modeId };
      this.#emit("mode", { currentModeId: modeId, by });
      this.#changed();
    }
    return this.#modes;
  }

  /**
   * True when this config option is the provider's permission-mode selector.
   * The supervisor uses this to keep every path to a mode change
   * operator-only (`mode`, `spawn --mode`, `spawn --config mode=…`, and
   * `option <id> mode …`).
   */
  isModeConfigOption(configId: string): boolean {
    const option = this.#configOptions?.find(
      (candidate) => candidate.id === configId,
    );
    return option !== undefined && isModeConfigOption(option);
  }

  /** Sets a provider-advertised session config option. */
  async setConfigOption(
    configId: string,
    value: string | boolean,
    by = "operator",
  ): Promise<SessionConfigOptionView[]> {
    this.#assertOpen();
    const { conn, agentSessionId } = this.#assertReady();
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

    const response = await conn.agent.request(
      "session/set_config_option",
      typeof resolvedValue === "boolean"
        ? {
            sessionId: agentSessionId,
            configId,
            type: "boolean" as const,
            value: resolvedValue,
          }
        : { sessionId: agentSessionId, configId, value: resolvedValue },
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

  /** Answer a pending provider question. */
  respondElicitation(
    action: "accept" | "decline" | "cancel",
    content: Record<string, string | number | boolean | string[]> | undefined,
    requestId: string | undefined,
    by = "operator",
  ): { requestId: string; action: "accept" | "decline" | "cancel" } {
    return this.#pendingInputs.respondElicitation(action, content, requestId, by);
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
      ...(this.#forkSessionId !== null
        ? { forkedFrom: this.#forkSessionId }
        : {}),
      envKeys: [
        ...new Set([
          ...Object.keys(this.#backendManifest.env),
          ...Object.keys(this.#env),
        ]),
      ].sort(),
    });

    const child = spawn(this.#backendManifest.command, this.#backendManifest.args, {
      cwd: this.cwd,
      env: buildSessionEnv({
        id: this.id,
        rootId: this.rootId,
        depth: this.depth,
        backend: this.backend,
        home: this.#home,
        cliPath: this.#cliPath,
        skillPath: this.#skillPath,
        skillVersion: this.#skillVersion,
        name: this.name,
        parentId: this.parentId,
        backendEnv: this.#backendManifest.env,
        env: this.#env,
      }),
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
      .onRequest("session/request_permission", ({ params, requestId, signal }) =>
        this.#pendingInputs.requestPermission(params, String(requestId), signal),
      )
      .onRequest("elicitation/create", ({ params, requestId, signal }) =>
        this.#pendingInputs.requestElicitation(params, String(requestId), signal),
      );

    this.#conn = app.connect(stream);
    this.#conn.closed.then(
      () => this.#onConnectionClosed(),
      (error) => this.#onConnectionClosed(error),
    );

    const init = await withTimeout(
      this.#conn.agent.request<{
        protocolVersion: number;
        agentCapabilities?: AgentCapabilities;
        agentInfo?: { name?: string; version?: string } | null;
        _meta?: unknown;
      }>("initialize", initializeParams()),
      this.#config.startupTimeoutMs,
      "ACP initialize",
    );
    assertAcpVersion(this.backend, init.protocolVersion);
    this.#caps = init.agentCapabilities ?? {};
    this.#agentName = init.agentInfo?.name ?? null;
    this.#agentVersion = init.agentInfo?.version ?? null;
    this.#steeringSupported = steeringSupported(init._meta);

    const replayStartSeq = this.#log.lastSeq + 1;
    let created: {
      sessionId: string;
      modes?: NewSessionResponse["modes"];
      configOptions?: NewSessionResponse["configOptions"];
    };
    if (this.#resumeSessionId !== null && this.#forkSessionId !== null) {
      throw new HlaoError(
        "spawn_failed",
        "a spawn cannot both resume and fork a provider session",
      );
    }
    if (this.#forkSessionId !== null) {
      if (
        this.#caps.sessionCapabilities?.fork === undefined ||
        this.#caps.sessionCapabilities?.fork === null
      ) {
        throw new HlaoError(
          "spawn_failed",
          `${this.backend} cannot fork provider session ${this.#forkSessionId}: the adapter does not advertise session/fork`,
        );
      }
      const forked = await withTimeout(
        this.#conn.agent.request("session/fork", {
          sessionId: this.#forkSessionId,
          cwd: this.cwd,
          mcpServers: [],
        }),
        this.#config.startupTimeoutMs,
        "ACP session/fork",
      );
      this.#agentSessionId = forked.sessionId;
      let modes = forked.modes;
      let configOptions = forked.configOptions;
      // `session/fork` returns a new session with the copied conversation but
      // sends no history to the client. Replay it explicitly when the backend
      // can load, so the new session shows what a human forking would see.
      if (this.#caps.loadSession) {
        this.#replaying = true;
        let loaded: {
          modes?: NewSessionResponse["modes"];
          configOptions?: NewSessionResponse["configOptions"];
        };
        try {
          loaded = await withTimeout(
            this.#conn.agent.request("session/load", {
              sessionId: forked.sessionId,
              cwd: this.cwd,
              mcpServers: [],
            }),
            this.#config.startupTimeoutMs,
            "ACP session/load",
          );
        } finally {
          this.#replaying = false;
        }
        modes = loaded.modes ?? modes;
        configOptions = loaded.configOptions ?? configOptions;
      }
      created = { sessionId: forked.sessionId, modes, configOptions };
    } else if (this.#resumeSessionId !== null) {
      // A backend that cannot replay history must fail loudly. Silently starting
      // a fresh conversation under the same id would present an empty session as
      // the interrupted one.
      if (!this.#caps.loadSession) {
        throw new HlaoError(
          "spawn_failed",
          `${this.backend} cannot resume provider session ${this.#resumeSessionId}: the adapter does not advertise loadSession`,
        );
      }
      // Replay notifications arrive before `session/load` resolves, so the
      // session id filter must already accept them.
      this.#agentSessionId = this.#resumeSessionId;
      this.#replaying = true;
      let loaded: { modes?: NewSessionResponse["modes"]; configOptions?: NewSessionResponse["configOptions"] };
      try {
        loaded = await withTimeout(
          this.#conn.agent.request("session/load", {
            sessionId: this.#resumeSessionId,
            cwd: this.cwd,
            mcpServers: [],
          }),
          this.#config.startupTimeoutMs,
          "ACP session/load",
        );
      } finally {
        this.#replaying = false;
      }
      created = {
        sessionId: this.#resumeSessionId,
        modes: loaded.modes,
        configOptions: loaded.configOptions,
      };
    } else {
      created = await withTimeout(
        this.#conn.agent.request("session/new", {
          cwd: this.cwd,
          mcpServers: [],
        }),
        this.#config.startupTimeoutMs,
        "ACP session/new",
      );
      this.#agentSessionId = created.sessionId;
    }
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
    const replayEndSeq = this.#log.lastSeq;
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
      forkSession: this.#caps.sessionCapabilities?.fork !== undefined &&
        this.#caps.sessionCapabilities?.fork !== null,
      resumed: this.#resumeSessionId !== null,
      forked: this.#forkSessionId !== null,
      ...(this.#forkSessionId !== null
        ? { forkedFrom: this.#forkSessionId }
        : {}),
    });
    if (this.#resumeSessionId !== null) {
      this.#emit("session.resumed", {
        agentSessionId: created.sessionId,
        historyStartSeq: replayStartSeq,
        historyEndSeq: replayEndSeq,
        historyEvents: Math.max(0, replayEndSeq - replayStartSeq + 1),
      });
    } else if (this.#forkSessionId !== null) {
      this.#emit("session.forked", {
        agentSessionId: created.sessionId,
        forkedFrom: this.#forkSessionId,
        historyLoaded: Boolean(this.#caps.loadSession),
        historyStartSeq: replayStartSeq,
        historyEndSeq: replayEndSeq,
        historyEvents: Math.max(0, replayEndSeq - replayStartSeq + 1),
      });
    }
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
    applyProviderState(this.#provider, update);
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
    if (update.sessionUpdate === "usage_update") {
      checkContextPressure(this.#provider, update.used, update.size, (data) => {
        this.#emit("notice", data);
      });
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

    this.#pendingInputs.clearAll(status, by);

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

  /** Reject any change to a session that has ended or is closing. */
  #assertOpen(): void {
    if (this.isTerminal || this.#closing) {
      throw new HlaoError(
        "session_closed",
        `session ${this.id} is ${this.isTerminal ? this.#status : "closing"}`,
      );
    }
  }

  /** Reject a request that needs the ACP connection before it exists. */
  #assertReady(): { conn: ClientConnection; agentSessionId: string } {
    if (!this.#ready || !this.#conn || !this.#agentSessionId) {
      throw new HlaoError("session_not_ready", `session ${this.id} is still starting`);
    }
    return { conn: this.#conn, agentSessionId: this.#agentSessionId };
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
    const event = this.#log.append({
      type,
      turn: turn ?? this.#active?.turn ?? null,
      data,
      replay: this.#replaying,
    });
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
