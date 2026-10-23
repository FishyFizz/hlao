import { statSync } from "node:fs";
import {
  mergeBackends,
  type BackendManifest,
  type HlaoConfig,
} from "../config.js";
import { HlaoError, describeError, toHlaoError } from "../errors.js";
import { generateSessionId } from "../ids.js";
import { recordSpawnReceipt } from "../ledger.js";
import type { SpawnParams, SpawnResult, SessionView } from "../protocol.js";
import { Session } from "../session.js";
import { MODE_CONFIG_ID } from "../session/config-options.js";
import { SKILL_VERSION, homeSkillPath } from "../skill.js";
import { actor, modeConfigOperatorOnlyError } from "./util.js";

export interface SpawnDeps {
  home: string;
  cliPath: string;
  /** The live session table; this service inserts into it, never owns it. */
  sessions: Map<string, Session>;
  /** Current config, re-read so a reload applies to the next spawn. */
  config(): HlaoConfig;
  /** False once shutdown has begun; no new session may land. */
  acceptingNew(): boolean;
  resolve(token: string): Session;
  logger: { info(line: string): void; warn(line: string): void };
  emitChange(): void;
}

interface IdempotentSpawn {
  sessionId: string;
  messageId: string | null;
  at: number;
}

/**
 * Spawn, resume, and fork: build one ACP-backed session, attach it to the live
 * table, and record the historical parent/child provider-id receipt. The
 * service owns no state that outlives the supervisor; its dedupe maps are a
 * retry window, not a registry.
 */
export class SpawnService {
  readonly #deps: SpawnDeps;
  /** Retry-safe spawn identity: idempotency key -> the session it produced. */
  readonly #idempotency = new Map<string, IdempotentSpawn>();
  /** In-flight spawns by idempotency key, so concurrent retries share one spawn. */
  readonly #pending = new Map<string, Promise<SpawnResult>>();
  /**
   * In-flight resumes by provider session id. A live-table lookup alone is not
   * enough: two concurrent resumes can both miss it before either registers.
   */
  readonly #pendingResumes = new Map<string, Promise<SpawnResult>>();
  /**
   * Provider ids this supervisor has observed to be durable (a transcript the
   * provider can load). A fresh session joins on its first turn; a resume or
   * fork joins at spawn. A duplicate reattach needs it to decide whether a
   * receipt is safe to write.
   */
  readonly #durable = new Set<string>();
  #inflight = 0;
  #idleResolvers: (() => void)[] = [];

  constructor(deps: SpawnDeps) {
    this.#deps = deps;
  }

  /** Resolve when no spawn is in flight, or after `timeoutMs`. */
  whenIdle(timeoutMs: number): Promise<void> {
    if (this.#inflight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.#idleResolvers.push(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  async spawn(params: SpawnParams, caller: string | null): Promise<SpawnResult> {
    if (!this.#deps.acceptingNew()) {
      throw new HlaoError("session_closed", "the supervisor is shutting down");
    }

    // Control is operator-only. Checked before idempotency/resume early
    // returns too, so a caller cannot smuggle a mode past a duplicate path.
    if (params.mode !== undefined && caller !== null) {
      throw new HlaoError(
        "operator_only",
        "only an operator shell without HLAO_SESSION_ID may pass --mode; an agent-spawned session uses the backend's defaultMode",
      );
    }
    // The bundled adapters also expose the permission mode as a config option;
    // this is the same control under another name and gets the same guard.
    if (caller !== null && params.config?.[MODE_CONFIG_ID] !== undefined) {
      throw modeConfigOperatorOnlyError(MODE_CONFIG_ID);
    }

    const key = params.idempotencyKey;
    if (key !== undefined) {
      this.#pruneIdempotency();
      const existing = this.#idempotency.get(key);
      if (existing !== undefined) {
        const session = this.#deps.sessions.get(existing.sessionId);
        if (session !== undefined && !session.isTerminal) {
          return this.#duplicateSpawn(session, existing.messageId);
        }
        this.#idempotency.delete(key);
      }
      const pending = this.#pending.get(key);
      if (pending !== undefined) {
        try {
          return { ...(await pending), duplicate: true };
        } catch {
          // The original attempt failed; this caller may try again.
        }
      }
    }

    const resumeKey =
      params.resumeSessionId !== undefined
        ? `${params.backend}\u0000${params.resumeSessionId}`
        : undefined;
    if (resumeKey !== undefined) {
      const pending = this.#pendingResumes.get(resumeKey);
      if (pending !== undefined) {
        try {
          return { ...(await pending), duplicate: true };
        } catch {
          // The original attempt failed; this caller may try again.
        }
      }
    }

    this.#inflight += 1;
    const work = this.#spawnInner(params, caller);
    if (key !== undefined) this.#pending.set(key, work);
    if (resumeKey !== undefined) this.#pendingResumes.set(resumeKey, work);
    try {
      return await work;
    } finally {
      if (key !== undefined && this.#pending.get(key) === work) {
        this.#pending.delete(key);
      }
      if (
        resumeKey !== undefined &&
        this.#pendingResumes.get(resumeKey) === work
      ) {
        this.#pendingResumes.delete(resumeKey);
      }
      this.#inflight -= 1;
      if (this.#inflight === 0) {
        for (const resolve of this.#idleResolvers.splice(0)) resolve();
      }
    }
  }

  #duplicateSpawn(session: Session, messageId: string | null): SpawnResult {
    const view = session.view();
    return {
      session: view,
      nextSeq: 0,
      duplicate: true,
      ...(messageId !== null ? { messageId } : {}),
      ...(view.createdBy !== null ? { createdBy: view.createdBy } : {}),
    };
  }

  /**
   * The parent a spawn will attach to. An agent caller is the default parent;
   * a stale or terminal caller is attribution, not an error, so the spawn
   * becomes a root.
   */
  #spawnParent(params: SpawnParams, caller: string | null): Session | null {
    if (params.parentSessionId !== undefined) {
      return this.#deps.resolve(params.parentSessionId);
    }
    if (caller !== null) {
      const own = this.#deps.sessions.get(caller);
      return own !== undefined && !own.isTerminal ? own : null;
    }
    return null;
  }

  /**
   * Write the receipt for one attachment. A parented spawn adds the parent
   * provider id; a root spawn records a null parent so an operator-started
   * agent is still recoverable after a restart. This is historical, not a live
   * mapping; a ledger append failure is logged and ignored so a full disk
   * cannot turn a successful spawn into an error.
   */
  #writeReceipt(parent: SessionView | null, child: SessionView): void {
    const childProviderId = child.agentSessionId;
    if (childProviderId === null) return;
    const parentProviderId = parent?.agentSessionId ?? null;
    if (parentProviderId !== null && parentProviderId === childProviderId) {
      return;
    }
    try {
      recordSpawnReceipt(this.#deps.home, {
        parentProviderId,
        parentSessionId: parent?.id ?? null,
        childProviderId,
        childSessionId: child.id,
        backend: child.backend,
        cwd: child.cwd,
        name: child.name,
      });
      this.#durable.add(childProviderId);
    } catch (error) {
      this.#deps.logger.warn(
        `spawn receipt not recorded: ${describeError(error)}`,
      );
    }
  }

  /**
   * A fresh provider session may live only in the adapter's memory until its
   * first turn persists a transcript. Recording it earlier would offer a
   * resume the provider cannot load ("Resource not found"). Defer the receipt
   * until the first turn starts, or drop it if the session ends untouched.
   * A resumed or forked conversation already exists, so it records at once.
   */
  #recordWhenDurable(parent: SessionView | null, session: Session): void {
    const record = (): boolean => {
      const view = session.view();
      if (view.turn > 0) {
        this.#writeReceipt(parent, view);
        return true;
      }
      return session.isTerminal;
    };
    if (record()) return;
    const off = session.onChange(() => {
      if (record()) off();
    });
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

  async #spawnInner(
    params: SpawnParams,
    caller: string | null,
  ): Promise<SpawnResult> {
    const config = this.#deps.config();
    const cwd = params.cwd ?? process.cwd();
    try {
      if (!statSync(cwd).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new HlaoError("bad_request", `cwd ${cwd} is not a readable directory`);
    }
    const merged = mergeBackends(config.backends, cwd);
    const backend = merged[params.backend];
    if (!backend) {
      throw new HlaoError(
        "backend_not_found",
        `unknown backend "${params.backend}" — available: ${Object.keys(merged).sort().join(", ")}`,
      );
    }
    this.#assertAvailable(backend);

    // Reattaching by provider id is idempotent while this supervisor is alive:
    // two adapters must never drive the same provider transcript. This is a
    // lookup in the live table, not a store.
    if (params.resumeSessionId !== undefined) {
      const attached = [...this.#deps.sessions.values()].find(
        (candidate) =>
          !candidate.isTerminal &&
          candidate.view().agentSessionId === params.resumeSessionId,
      );
      if (attached !== undefined) {
        if (attached.backend !== backend.name) {
          throw new HlaoError(
            "bad_request",
            `provider session ${params.resumeSessionId} is attached to ${attached.id} on backend ${attached.backend}, not ${backend.name}`,
          );
        }
        // A duplicate resume still says "this parent attached this provider
        // conversation"; record it so a later reboot can recover the pair. A
        // provider id with no durable transcript yet is skipped: the original
        // spawn records it when the session first runs a turn.
        const attachedView = attached.view();
        const parentView = this.#spawnParent(params, caller)?.view() ?? null;
        const providerId = attachedView.agentSessionId;
        if (providerId !== null && this.#durable.has(providerId)) {
          this.#writeReceipt(parentView, attachedView);
        }
        return { ...this.#duplicateSpawn(attached, null), resumed: true };
      }
    }

    const parent = this.#spawnParent(params, caller);
    if (parent?.isTerminal) {
      throw new HlaoError(
        "session_closed",
        `parent session ${parent.id} is ${parent.view().status}`,
      );
    }

    const id = generateSessionId((candidate) => this.#deps.sessions.has(candidate));
    const rootId = parent?.rootId ?? id;
    const depth = parent ? parent.depth + 1 : 0;
    // operator --mode -> backend defaultMode -> the provider's own default.
    // A reattach (resume or fork) continues an existing conversation: the
    // provider's persisted mode is the default, and the backend defaultMode
    // applies only to a genuinely new session. An explicit operator --mode
    // still wins.
    const reattaching =
      params.resumeSessionId !== undefined || params.forkSessionId !== undefined;
    const effectiveMode =
      params.mode ?? (reattaching ? undefined : backend.defaultMode);

    const session = await Session.spawn({
      id,
      backend,
      cwd,
      parentId: parent?.id ?? null,
      rootId,
      depth,
      name: params.name ?? null,
      createdBy: actor(caller),
      requestedMode: effectiveMode,
      env: params.env ?? {},
      permissionTimeoutMs: config.permissionTimeoutMs,
      maxPendingPermissions: config.maxPendingPermissions,
      home: this.#deps.home,
      config: {
        startupTimeoutMs: config.startupTimeoutMs,
        maxEventsPerSession: config.maxEventsPerSession,
        maxEventLogBytes: config.maxEventLogBytes,
        maxEventBytes: config.maxEventBytes,
      },
      cliPath: this.#deps.cliPath,
      skill: params.skill ?? true,
      skillPath: homeSkillPath(this.#deps.home),
      skillVersion: SKILL_VERSION,
      ...(params.resumeSessionId !== undefined
        ? { resumeSessionId: params.resumeSessionId }
        : {}),
      ...(params.forkSessionId !== undefined
        ? { forkSessionId: params.forkSessionId }
        : {}),
      log: (line) => this.#deps.logger.info(line),
    });

    if (!this.#deps.acceptingNew()) {
      await session.close(true);
      throw new HlaoError("session_closed", "the supervisor is shutting down");
    }

    // Any failure while applying spawn options closes the half-built session
    // before the error propagates; a failed spawn never stays in the table.
    const apply = async (work: () => Promise<unknown>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        await session.close(true, actor(caller));
        throw error;
      }
    };

    if (effectiveMode !== undefined) {
      await apply(() => session.setMode(effectiveMode, actor(caller)));
    }
    if (params.model !== undefined) {
      await apply(() => session.setModel(params.model!, actor(caller)));
    }
    for (const [configId, value] of Object.entries(params.config ?? {})) {
      // Covers an adapter that names its mode option something other than
      // "mode": category "mode" is the general signal.
      if (caller !== null && session.isModeConfigOption(configId)) {
        await session.close(true, actor(caller));
        throw modeConfigOperatorOnlyError(configId);
      }
      await apply(() => session.setConfigOption(configId, value, actor(caller)));
    }

    this.#deps.sessions.set(id, session);
    if (params.idempotencyKey !== undefined) {
      this.#idempotency.set(params.idempotencyKey, {
        sessionId: id,
        messageId: null,
        at: Date.now(),
      });
    }
    session.onChange(() => this.#deps.emitChange());
    this.#deps.emitChange();
    this.#deps.logger.info(
      `spawned ${id} (${backend.name}) in ${cwd}${parent ? ` parent=${parent.id}` : ""}`,
    );
    const parentView = parent?.view() ?? null;
    if (
      params.resumeSessionId !== undefined ||
      params.forkSessionId !== undefined
    ) {
      this.#writeReceipt(parentView, session.view());
    } else {
      this.#recordWhenDurable(parentView, session);
    }

    const result: SpawnResult = {
      session: session.view(),
      nextSeq: 0,
      createdBy: actor(caller),
      ...(params.resumeSessionId !== undefined ? { resumed: true } : {}),
      ...(params.forkSessionId !== undefined ? { forked: true } : {}),
    };

    if (params.prompt !== undefined) {
      try {
        const sent = await session.send(
          params.prompt,
          params.wait ?? false,
          params.timeoutMs ?? config.sendWaitTimeoutMs,
          actor(caller),
        );
        result.messageId = sent.messageId;
        if (params.idempotencyKey !== undefined) {
          const entry = this.#idempotency.get(params.idempotencyKey);
          if (entry !== undefined) entry.messageId = sent.messageId;
        }
        if (params.wait) {
          result.firstTurn = {
            stopReason: sent.stopReason,
            text: sent.text ?? "",
            timedOut: sent.timedOut,
          };
        }
      } catch (error) {
        const converted = toHlaoError(error);
        throw new HlaoError(converted.code, converted.message, {
          sessionId: session.id,
          session: session.view(),
          ...(converted.details !== undefined ? { cause: converted.details } : {}),
        });
      }
      result.session = session.view();
    }

    return result;
  }

  #assertAvailable(backend: BackendManifest): void {
    if (!backend.available) {
      throw new HlaoError(
        "backend_unavailable",
        `backend "${backend.name}" is unavailable: ${backend.unavailableReason ?? "unknown reason"}`,
      );
    }
  }
}
