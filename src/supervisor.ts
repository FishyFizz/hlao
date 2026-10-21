import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import {
  configFingerprint,
  loadConfig,
  mergeBackends,
  toAgentView,
  type HlaoConfig,
} from "./config.js";
import { clearCrashMarker, readCrashMarker, writeCrashMarker } from "./crash.js";
import { HlaoError, describeError, toHlaoError } from "./errors.js";
import { generateSessionId } from "./ids.js";
import {
  pidAlive,
  probeSupervisor,
  readLock,
  removeLock,
  updateLock,
  writeLockExclusive,
  type LockInfo,
} from "./lock.js";
import { Logger } from "./logger.js";
import { ensureHome, isWindows, lockPath, supervisorEndpoint } from "./paths.js";
import { resolveSession } from "./supervisor/resolve.js";
import { actor, delay, failure, pathKey } from "./supervisor/util.js";
import { SKILL_VERSION, ensureHomeSkill, homeSkillPath } from "./skill.js";
import { nowIso } from "./time.js";
import {
  FrameTooLargeError,
  createWireServer,
  pathTarget,
  type WireStream,
  type WireStreamServer,
} from "./stream.js";
import {
  PROTOCOL_CAPABILITIES,
  WIRE_PROTOCOL_MAJOR,
  WIRE_PROTOCOL_VERSION,
  isMethod,
  parseEnvelope,
  parseParams,
  type BackendsListParams,
  type BackendsListResult,
  type CancelParams,
  type CancelResult,
  type CloseParams,
  type CloseResult,
  type GetParams,
  type GetResult,
  type ForgetParams,
  type ForgetResult,
  type HelloParams,
  type HelloResult,
  type LastCrash,
  type ListParams,
  type ListResult,
  type NotificationFrame,
  type PermitParams,
  type PermitResult,
  type ProviderSessionView,
  type ProviderSessionsParams,
  type ProviderSessionsResult,
  type RespondElicitationParams,
  type RespondElicitationResult,
  type QueueDropParams,
  type QueueDropResult,
  type QueueParams,
  type QueueResult,
  type ReadParams,
  type ReadResult,
  type ReloadParams,
  type ReloadResult,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SendParams,
  type SendResult,
  type SessionView,
  type RenameParams,
  type RenameResult,
  type SetConfigOptionParams,
  type SetConfigOptionResult,
  type SetModeParams,
  type SetModeResult,
  type ShutdownParams,
  type ShutdownResult,
  type SpawnParams,
  type SpawnResult,
  type SubscribeParams,
  type SubscribeResult,
  type UnsubscribeParams,
  type UnsubscribeResult,
  type WaitParams,
  type WaitResult,
  type WaitTargetResult,
} from "./protocol.js";
import { isTerminalStatus } from "./protocol.js";
import { listProviderSessions } from "./provider.js";
import { Session } from "./session.js";

/** A persistent connection may have this many requests in flight. */
const MAX_INFLIGHT_REQUESTS = 64;
/** Events delivered per session per notification flush. */
const MAX_NOTIFICATION_EVENTS = 200;
/** Close a consumer that lets this much data sit in the transport buffer. */
const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
/** Subscriptions one persistent connection may hold. */
const MAX_SUBSCRIPTIONS = 64;

interface SubscriptionState {
  id: number;
  /** Report views for every session in the instance, including new ones. */
  all: boolean;
  /** Stream events for these sessions (and report their views). */
  sessionIds: Set<string>;
  /** Last delivered event seq per session; pass as `since` to read. */
  cursors: Map<string, number>;
  /** Last view sent per session, serialized for change detection. */
  lastViews: Map<string, string>;
}

interface ConnectionState {
  stream: WireStream;
  persistent: boolean;
  subscriptions: Map<number, SubscriptionState>;
  nextSubscription: number;
  inflight: number;
  flushScheduled: boolean;
  closed: boolean;
  observer: (() => void) | null;
  /** The first frame decides the connection mode; later frames wait for it. */
  handshaking: boolean;
  early: string[];
}

class AlreadyRunningError extends Error {
  override readonly name = "AlreadyRunningError";
  constructor(readonly lock: LockInfo) {
    super(`another HLAO supervisor is already running (pid ${lock.pid})`);
  }
}

export interface SupervisorOptions {
  home: string;
  cliPath: string;
  version: string;
}

class SupervisorServer {
  readonly endpoint: string;
  readonly token: string;

  #home: string;
  #cliPath: string;
  #version: string;
  #startedAt: string;
  #logger: Logger;
  #config: HlaoConfig;
  #configHash: string;
  #configError: string | null;
  /** The lock owner replaced by this start, when it did not stop cleanly. */
  #lastCrash: LastCrash | null = null;
  #sessions = new Map<string, Session>();
  /**
   * Blocking cross-session waits held by in-flight requests:
   * caller -> target -> reference count. A cycle is a turn-level deadlock:
   * the target's queued message cannot run until the caller's turn ends, and
   * the caller's turn cannot end until the target's turn does.
   */
  #waitEdges = new Map<string, Map<string, number>>();
  #server: WireStreamServer | null = null;
  #streams = new Set<WireStream>();
  #changeObservers = new Set<() => void>();
  #lock: LockInfo | null = null;
  #stopping = false;
  #acceptingNew = true;
  #inflightSpawns = 0;
  /** Retry-safe spawn identity: idempotency key -> the session it produced. */
  #spawnIdempotency = new Map<
    string,
    { sessionId: string; messageId: string | null; at: number }
  >();
  /** In-flight spawns by idempotency key, so concurrent retries share one spawn. */
  #pendingSpawns = new Map<string, Promise<SpawnResult>>();
  /**
   * In-flight resumes by provider session id. A live-table lookup alone is not
   * enough: two concurrent resumes can both miss it before either registers.
   */
  #pendingResumes = new Map<string, Promise<SpawnResult>>();
  #spawnIdleResolvers: (() => void)[] = [];
  #shutdownAfterResponse: { force: boolean } | null = null;
  #stoppedPromise: Promise<void>;
  #resolveStopped!: () => void;

  constructor(options: SupervisorOptions) {
    this.#home = options.home;
    this.#cliPath = options.cliPath;
    this.#version = options.version;
    this.#startedAt = new Date().toISOString();
    this.#logger = new Logger(options.home);
    const loaded = loadConfig(options.home);
    this.#config = loaded.config;
    this.#configHash = configFingerprint(options.home);
    this.#configError = loaded.error ? loaded.error.message : null;
    if (loaded.error) this.#logger.error(`config: ${loaded.error.message}`);

    this.endpoint = supervisorEndpoint(options.home);
    this.token = randomBytes(24).toString("hex");
    this.#stoppedPromise = new Promise<void>((resolvePromise) => {
      this.#resolveStopped = resolvePromise;
    });
  }

  get stopped(): Promise<void> {
    return this.#stoppedPromise;
  }

  async start(): Promise<void> {
    // A supervisor that cannot read its config must not come up as an empty
    // instance. The CLI reports this before autostart and exits 1.
    if (this.#configError !== null) {
      throw new HlaoError("config_invalid", this.#configError);
    }
    ensureHome(this.#home);
    try {
      ensureHomeSkill(this.#home);
    } catch (error) {
      this.#logger.warn(`skill: ${describeError(error)}`);
    }
    await this.#acquireLock();

    try {
      if (!isWindows() && existsSync(this.endpoint)) {
        try {
          unlinkSync(this.endpoint);
        } catch {
          // Best effort; listen will report a real conflict.
        }
      }

      const server = createWireServer(pathTarget(this.endpoint));
      this.#server = server;
      server.onConnection((stream) => this.#onConnection(stream));
      server.onError((error) => {
        this.#logger.error(`server error: ${describeError(error)}`);
      });

      try {
        await server.listen();
      } catch (error) {
        throw new HlaoError(
          "internal",
          `cannot listen on ${this.endpoint}: ${describeError(error)}`,
        );
      }

      if (!isWindows()) {
        try {
          chmodSync(this.endpoint, 0o600);
        } catch {
          // Windows ACLs and some filesystems do not support this.
        }
      }

      this.#lock = {
        ...this.#lock!,
        state: "running",
      };
      if (!(await updateLock(this.#home, this.#lock))) {
        this.#logger.warn(
          "could not rewrite the lock state; continuing with the startup lock",
        );
      }
    } catch (error) {
      removeLock(this.#home, this.token);
      try {
        this.#server?.close();
      } catch {
        // Never started.
      }
      throw error;
    }
  }

  async stop(force = false): Promise<number> {
    if (this.#stopping) return 0;
    this.#stopping = true;
    this.#acceptingNew = false;
    this.#shutdownAfterResponse = null;

    // A spawn already handshaking is not in the live table yet. Let it land so
    // the shutdown check can close it, rather than orphaning its adapter.
    await this.#waitForInflightSpawns(5_000);

    const live = [...this.#sessions.values()].filter((session) => !session.isTerminal);
    await Promise.allSettled(live.map((session) => session.close(force)));

    for (const stream of this.#streams) {
      stream.terminate();
    }

    if (this.#server) {
      await this.#server.close();
    }

    removeLock(this.#home, this.token);
    clearCrashMarker(this.#home);
    if (!isWindows()) {
      try {
        unlinkSync(this.endpoint);
      } catch {
        // Already gone.
      }
    }
    this.#logger.info(`supervisor stopped (${live.length} sessions closed)`);
    this.#resolveStopped();
    return live.length;
  }

  async #acquireLock(): Promise<void> {
    const info: LockInfo = {
      pid: process.pid,
      token: this.token,
      endpoint: this.endpoint,
      protocolVersion: WIRE_PROTOCOL_MAJOR,
      startedAt: this.#startedAt,
      version: this.#version,
      state: "starting",
    };
    let detectedCrash: LastCrash | null = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = readLock(this.#home);
      if (existing) {
        if (existing.pid === process.pid) {
          // A lock left by this pid but a different token: ours is mid-write.
          removeLock(this.#home, existing.token);
        } else if (pidAlive(existing.pid)) {
          const age = Date.now() - Date.parse(existing.startedAt);
          const probe = await probeSupervisor(existing);
          if (probe.alive) {
            // A live old-major supervisor is never a crash. Refuse the start
            // and leave its lock and endpoint untouched.
            if (probe.major !== WIRE_PROTOCOL_MAJOR) {
              throw new HlaoError(
                "version_mismatch",
                `a live supervisor speaks wire protocol major ${probe.major ?? "unknown"}; this supervisor is ${WIRE_PROTOCOL_MAJOR}. Stop the old one with its own CLI ("hlao down") or with this CLI's legacy "hlao down", then start again. Its lock was left in place.`,
                { supervisorMajor: probe.major, supervisorVersion: existing.version },
              );
            }
            throw new AlreadyRunningError(existing);
          }
          if (Number.isFinite(age) && age < 30_000) {
            // A just-written lock may belong to a supervisor that is still
            // binding its endpoint; give it the startup window.
            throw new AlreadyRunningError(existing);
          }
          detectedCrash = this.#crashFromLock(existing);
          removeLock(this.#home, existing.token);
        } else {
          detectedCrash = this.#crashFromLock(existing);
          removeLock(this.#home, existing.token);
        }
      } else if (existsSync(lockPath(this.#home))) {
        // An unreadable lock is almost always a crash remnant; give a just-
        // written lock one beat to become readable before declaring it stale.
        await delay(100);
        if (readLock(this.#home)) continue;
        removeLock(this.#home);
      }

      if (writeLockExclusive(this.#home, info)) {
        if (detectedCrash !== null) {
          try {
            writeCrashMarker(this.#home, detectedCrash);
          } catch (error) {
            this.#logger.warn(
              `could not record the previous supervisor crash: ${describeError(error)}`,
            );
          }
        }
        this.#lastCrash = detectedCrash ?? readCrashMarker(this.#home);
        this.#lock = info;
        return;
      }
    }

    const owner = readLock(this.#home);
    if (owner) throw new AlreadyRunningError(owner);
    throw new HlaoError("internal", "could not acquire the supervisor lock");
  }

  #crashFromLock(lock: LockInfo): LastCrash {
    return {
      pid: lock.pid,
      version: lock.version,
      startedAt: lock.startedAt,
      detectedAt: nowIso(),
    };
  }

  // -------------------------------------------------------------------------
  // connections
  // -------------------------------------------------------------------------

  #onConnection(stream: WireStream): void {
    this.#streams.add(stream);
    const abort = new AbortController();
    const state: ConnectionState = {
      stream,
      persistent: false,
      subscriptions: new Map(),
      nextSubscription: 1,
      inflight: 0,
      flushScheduled: false,
      closed: false,
      observer: null,
      handshaking: true,
      early: [],
    };

    stream.onClose(() => {
      abort.abort();
      this.#streams.delete(stream);
      state.closed = true;
      if (state.observer !== null) {
        this.#changeObservers.delete(state.observer);
        state.observer = null;
      }
      state.subscriptions.clear();
    });

    let first = true;
    const initialTimer = setTimeout(() => {
      if (first && !state.closed) stream.terminate();
    }, 15_000);
    initialTimer.unref?.();

    stream.onError((error) => {
      if (state.closed) return;
      if (first) {
        first = false;
        clearTimeout(initialTimer);
        if (error instanceof FrameTooLargeError) {
          this.#write(
            stream,
            failure(0, new HlaoError("bad_request", "request frame too large")),
          );
          stream.close();
          return;
        }
      }
      abort.abort();
      state.closed = true;
      stream.terminate();
    });

    stream.onFrame((line) => {
      if (state.closed) return;
      if (first) {
        first = false;
        clearTimeout(initialTimer);
        void this.#handleFrame(line, state, abort.signal).then(() => {
          state.handshaking = false;
          for (const queued of state.early.splice(0)) {
            if (state.closed) break;
            void this.#handleFrame(queued, state, abort.signal);
          }
        });
        return;
      }
      if (state.handshaking) {
        if (state.early.length >= MAX_INFLIGHT_REQUESTS) {
          state.closed = true;
          stream.terminate();
          return;
        }
        state.early.push(line);
        return;
      }
      void this.#handleFrame(line, state, abort.signal);
    });
  }

  async #handleFrame(
    line: string,
    state: ConnectionState,
    signal: AbortSignal,
  ): Promise<void> {
    let id = 0;
    let envelope: RequestEnvelope | null = null;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new HlaoError("bad_request", "request is not valid JSON");
      }
      envelope = parseEnvelope(parsed);
      id = envelope.id;
      if (state.inflight >= MAX_INFLIGHT_REQUESTS) {
        throw new HlaoError(
          "too_many_requests",
          `at most ${MAX_INFLIGHT_REQUESTS} requests may be in flight`,
        );
      }
      state.inflight += 1;
      try {
        const result = await this.#handleEnvelope(envelope, signal, state);
        this.#write(state.stream, { id, ok: true, result });
        if (!state.persistent && this.#requestsPersistentStream(envelope)) {
          state.persistent = true;
          state.observer = () => this.#scheduleFlush(state);
          this.#changeObservers.add(state.observer);
        }
      } finally {
        state.inflight -= 1;
      }
    } catch (error) {
      this.#write(state.stream, failure(id, error));
    }

    this.#scheduleFlush(state);

    // A legacy connection carries exactly one request, as in protocol 2.0.
    if (!state.persistent) {
      state.closed = true;
      state.stream.close();
    }

    const shutdown = this.#shutdownAfterResponse;
    if (shutdown) {
      this.#shutdownAfterResponse = null;
      setImmediate(() => {
        void this.stop(shutdown.force);
      });
    }
  }

  #requestsPersistentStream(envelope: RequestEnvelope): boolean {
    if (envelope.method !== "hello") return false;
    try {
      return parseParams("hello", envelope.params).stream?.persistent === true;
    } catch {
      return false;
    }
  }

  async #handleEnvelope(
    envelope: RequestEnvelope,
    signal: AbortSignal,
    connection?: ConnectionState,
  ): Promise<unknown> {
    if (envelope.token !== this.token) {
      throw new HlaoError("unauthorized", "invalid supervisor token");
    }
    if (!isMethod(envelope.method)) {
      throw new HlaoError("bad_request", `unknown method "${envelope.method}"`);
    }

    // Housekeeping is lazy on purpose: the supervisor owns no recurring timer.
    this.#sweep();

    const method = envelope.method;
    if (this.#configError !== null && method === "sessions.spawn") {
      throw new HlaoError("config_invalid", this.#configError);
    }
    const params = parseParams(method, envelope.params);
    const caller = envelope.callerSessionId;

    switch (method) {
      case "hello": {
        const hello = params as HelloParams;
        if (
          hello.protocolVersion !== undefined &&
          hello.protocolVersion.major !== WIRE_PROTOCOL_MAJOR
        ) {
          throw new HlaoError(
            "version_mismatch",
            `client speaks wire protocol ${hello.protocolVersion.major}.${hello.protocolVersion.minor}; this supervisor speaks ${WIRE_PROTOCOL_VERSION.major}.${WIRE_PROTOCOL_VERSION.minor}`,
            {
              client: hello.protocolVersion,
              supervisor: WIRE_PROTOCOL_VERSION,
            },
          );
        }
        const result: HelloResult = {
          protocolVersion: WIRE_PROTOCOL_VERSION,
          capabilities: [...PROTOCOL_CAPABILITIES],
          pid: process.pid,
          startedAt: this.#startedAt,
          version: this.#version,
          sessions: [...this.#sessions.values()].filter((session) => !session.isTerminal)
            .length,
          configHash: this.#configHash,
          configError: this.#configError ?? undefined,
          ...(this.#lastCrash !== null ? { lastCrash: this.#lastCrash } : {}),
          ...(hello.stream !== undefined
            ? { stream: { persistent: hello.stream.persistent === true } }
            : {}),
        };
        return result;
      }
      case "backends.list":
        return this.#backends(params as BackendsListParams, caller);
      case "backends.sessions":
        return this.#providerSessions(
          params as ProviderSessionsParams,
          caller,
          signal,
        );
      case "sessions.spawn":
        return this.#spawn(params as SpawnParams, caller);
      case "sessions.list":
        return this.#list(params as ListParams);
      case "sessions.get":
        return this.#get(params as GetParams);
      case "sessions.send":
        return this.#send(params as SendParams, caller);
      case "sessions.read":
        return this.#read(params as ReadParams);
      case "sessions.wait":
        return this.#wait(params as WaitParams, signal, caller);
      case "sessions.cancel":
        return this.#cancel(params as CancelParams, caller);
      case "sessions.close":
        return this.#close(params as CloseParams, caller);
      case "sessions.permit":
        return this.#permit(params as PermitParams, caller);
      case "sessions.respond_elicitation":
        return this.#respondElicitation(
          params as RespondElicitationParams,
          caller,
        );
      case "sessions.set_mode":
        return this.#setMode(params as SetModeParams, caller);
      case "sessions.set_config_option":
        return this.#setConfigOption(params as SetConfigOptionParams, caller);
      case "sessions.queue":
        return this.#queue(params as QueueParams);
      case "sessions.queue_drop":
        return this.#queueDrop(params as QueueDropParams, caller);
      case "sessions.rename":
        return this.#rename(params as RenameParams, caller);
      case "sessions.forget":
        return this.#forget(params as ForgetParams);
      case "stream.subscribe":
        return this.#subscribe(params as SubscribeParams, connection);
      case "stream.unsubscribe":
        return this.#unsubscribe(params as UnsubscribeParams, connection);
      case "supervisor.reload":
        return this.#reload(params as ReloadParams, caller);
      case "supervisor.shutdown":
        return this.#shutdown(params as ShutdownParams, caller);
      default: {
        const unreachable: never = method;
        throw new HlaoError("bad_request", `unhandled method ${String(unreachable)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // methods
  // -------------------------------------------------------------------------

  async #spawn(params: SpawnParams, caller: string | null): Promise<SpawnResult> {
    if (!this.#acceptingNew) {
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

    const key = params.idempotencyKey;
    if (key !== undefined) {
      this.#pruneSpawnIdempotency();
      const existing = this.#spawnIdempotency.get(key);
      if (existing !== undefined) {
        const session = this.#sessions.get(existing.sessionId);
        if (session !== undefined && !session.isTerminal) {
          return this.#duplicateSpawn(session, existing.messageId);
        }
        this.#spawnIdempotency.delete(key);
      }
      const pending = this.#pendingSpawns.get(key);
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

    this.#inflightSpawns += 1;
    const work = this.#spawnInner(params, caller);
    if (key !== undefined) this.#pendingSpawns.set(key, work);
    if (resumeKey !== undefined) this.#pendingResumes.set(resumeKey, work);
    try {
      return await work;
    } finally {
      if (key !== undefined && this.#pendingSpawns.get(key) === work) {
        this.#pendingSpawns.delete(key);
      }
      if (resumeKey !== undefined && this.#pendingResumes.get(resumeKey) === work) {
        this.#pendingResumes.delete(resumeKey);
      }
      this.#inflightSpawns -= 1;
      if (this.#inflightSpawns === 0) {
        for (const resolve of this.#spawnIdleResolvers.splice(0)) resolve();
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

  #pruneSpawnIdempotency(): void {
    const cutoff = Date.now() - 60 * 60 * 1_000;
    for (const [key, entry] of this.#spawnIdempotency) {
      if (entry.at < cutoff) this.#spawnIdempotency.delete(key);
    }
    while (this.#spawnIdempotency.size > 256) {
      const oldest = this.#spawnIdempotency.keys().next().value;
      if (oldest === undefined) break;
      this.#spawnIdempotency.delete(oldest);
    }
  }

  async #spawnInner(params: SpawnParams, caller: string | null): Promise<SpawnResult> {
    const cwd = params.cwd ?? process.cwd();
    try {
      if (!statSync(cwd).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new HlaoError("bad_request", `cwd ${cwd} is not a readable directory`);
    }
    const merged = mergeBackends(this.#config.backends, cwd);
    const backend = merged[params.backend];
    if (!backend) {
      throw new HlaoError(
        "backend_not_found",
        `unknown backend "${params.backend}" — available: ${Object.keys(merged).sort().join(", ")}`,
      );
    }
    if (!backend.available) {
      throw new HlaoError(
        "backend_unavailable",
        `backend "${params.backend}" is unavailable: ${backend.unavailableReason ?? "unknown reason"}`,
      );
    }

    // Reattaching by provider id is idempotent while this supervisor is alive:
    // two adapters must never drive the same provider transcript. This is a
    // lookup in the live table, not a store.
    if (params.resumeSessionId !== undefined) {
      const attached = [...this.#sessions.values()].find(
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
        return { ...this.#duplicateSpawn(attached, null), resumed: true };
      }
    }

    let parent: Session | null = null;
    if (params.parentSessionId !== undefined) {
      parent = this.#resolve(params.parentSessionId);
    } else if (caller !== null) {
      // A stale or terminal caller is attribution, not an error: the spawn becomes a root.
      const own = this.#sessions.get(caller);
      parent = own !== undefined && !own.isTerminal ? own : null;
    }

    if (parent?.isTerminal) {
      throw new HlaoError(
        "session_closed",
        `parent session ${parent.id} is ${parent.view().status}`,
      );
    }

    const id = generateSessionId((candidate) => this.#sessions.has(candidate));
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
      permissionTimeoutMs: this.#config.permissionTimeoutMs,
      maxPendingPermissions: this.#config.maxPendingPermissions,
      home: this.#home,
      config: {
        startupTimeoutMs: this.#config.startupTimeoutMs,
        maxEventsPerSession: this.#config.maxEventsPerSession,
        maxEventLogBytes: this.#config.maxEventLogBytes,
        maxEventBytes: this.#config.maxEventBytes,
      },
      cliPath: this.#cliPath,
      skill: params.skill ?? true,
      skillPath: homeSkillPath(this.#home),
      skillVersion: SKILL_VERSION,
      ...(params.resumeSessionId !== undefined
        ? { resumeSessionId: params.resumeSessionId }
        : {}),
      ...(params.forkSessionId !== undefined
        ? { forkSessionId: params.forkSessionId }
        : {}),
      log: (line) => this.#logger.info(line),
    });

    if (!this.#acceptingNew) {
      await session.close(true);
      throw new HlaoError("session_closed", "the supervisor is shutting down");
    }

    if (effectiveMode !== undefined) {
      try {
        await session.setMode(effectiveMode, actor(caller));
      } catch (error) {
        await session.close(true, actor(caller));
        throw error;
      }
    }

    if (params.model !== undefined) {
      try {
        await session.setModel(params.model, actor(caller));
      } catch (error) {
        await session.close(true, actor(caller));
        throw error;
      }
    }

    for (const [configId, value] of Object.entries(params.config ?? {})) {
      try {
        await session.setConfigOption(configId, value, actor(caller));
      } catch (error) {
        await session.close(true, actor(caller));
        throw error;
      }
    }

    this.#sessions.set(id, session);
    if (params.idempotencyKey !== undefined) {
      this.#spawnIdempotency.set(params.idempotencyKey, {
        sessionId: id,
        messageId: null,
        at: Date.now(),
      });
    }
    session.onChange(() => this.#emitChange());
    this.#emitChange();
    this.#logger.info(
      `spawned ${id} (${backend.name}) in ${cwd}${parent ? ` parent=${parent.id}` : ""}`,
    );

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
          params.timeoutMs ?? this.#config.sendWaitTimeoutMs,
          actor(caller),
        );
        result.messageId = sent.messageId;
        if (params.idempotencyKey !== undefined) {
          const entry = this.#spawnIdempotency.get(params.idempotencyKey);
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
        throw new HlaoError(
          toHlaoError(error).code,
          toHlaoError(error).message,
          {
            sessionId: session.id,
            session: session.view(),
            ...(toHlaoError(error).details !== undefined
              ? { cause: toHlaoError(error).details }
              : {}),
          },
        );
      }
      result.session = session.view();
    }

    return result;
  }

  #list(params: ListParams): ListResult {
    let sessions = [...this.#sessions.values()];
    if (!params.includeClosed) {
      sessions = sessions.filter((session) => session.view().status !== "closed");
    }
    if (params.cwd !== undefined) {
      const target = pathKey(params.cwd);
      sessions = sessions.filter(
        (session) => pathKey(session.cwd) === target,
      );
    }
    sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      sessions: sessions.map((session) => session.view()),
    };
  }

  #get(params: GetParams): GetResult {
    return { session: this.#resolve(params.sessionId).view() };
  }

  /**
   * Backend discovery for any client. The bundled CLI's `agents` command is the
   * same merge done locally, so it works without a supervisor; this method is
   * how a dashboard or MCP client sees the same list without reading config.
   */
  #backends(params: BackendsListParams, caller: string | null): BackendsListResult {
    if (this.#configError !== null) {
      throw new HlaoError("config_invalid", this.#configError);
    }
    const callerSession = caller !== null ? this.#sessions.get(caller) : undefined;
    const cwd = params.cwd ?? callerSession?.cwd ?? process.cwd();
    const merged = mergeBackends(this.#config.backends, cwd);
    return {
      backends: Object.values(merged)
        .map(toAgentView)
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  /**
   * Read the provider's own session catalog and join it to the live table.
   *
   * The provider owns the rows; the live join answers "does this HLAO instance
   * currently drive this provider session?" without persisting any mapping.
   * A row with `attached: false` is provider-only: it may be an external
   * session, or a session this instance used before a restart. The caller
   * decides whether to adopt it.
   */
  async #providerSessions(
    params: ProviderSessionsParams,
    caller: string | null,
    signal: AbortSignal,
  ): Promise<ProviderSessionsResult> {
    if (!this.#acceptingNew) {
      throw new HlaoError("session_closed", "the supervisor is shutting down");
    }
    if (this.#configError !== null) {
      throw new HlaoError("config_invalid", this.#configError);
    }
    const callerSession = caller !== null ? this.#sessions.get(caller) : undefined;
    const mergeCwd = params.cwd ?? callerSession?.cwd ?? process.cwd();
    const merged = mergeBackends(this.#config.backends, mergeCwd);
    const backend = merged[params.backend];
    if (backend === undefined) {
      throw new HlaoError(
        "backend_not_found",
        `unknown backend "${params.backend}" — available: ${Object.keys(merged).sort().join(", ")}`,
      );
    }
    if (!backend.available) {
      throw new HlaoError(
        "backend_unavailable",
        `backend "${backend.name}" is unavailable: ${backend.unavailableReason ?? "unknown reason"}`,
      );
    }

    const catalog = await listProviderSessions({
      backend,
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      timeoutMs: this.#config.startupTimeoutMs,
      processCwd: mergeCwd,
      signal,
      log: (line) => this.#logger.info(line),
    });

    const live = [...this.#sessions.values()].filter(
      (candidate) =>
        !candidate.isTerminal && candidate.backend === backend.name,
    );
    const sessions: ProviderSessionView[] = catalog.sessions.map((row) => {
      const attached = live.find(
        (candidate) => candidate.view().agentSessionId === row.sessionId,
      );
      const view = attached?.view();
      return {
        sessionId: row.sessionId,
        cwd: row.cwd,
        title: row.title,
        updatedAt: row.updatedAt,
        attached: view !== undefined,
        hlaoSessionId: view?.id ?? null,
        hlaoName: view?.name ?? null,
        hlaoStatus: view?.status ?? null,
        loadable: catalog.capabilities.load,
        forkable: catalog.capabilities.fork,
      };
    });

    return {
      backend: backend.name,
      cwd: params.cwd ?? null,
      agentName: catalog.agentName,
      agentVersion: catalog.agentVersion,
      sessions,
      nextCursor: catalog.nextCursor,
    };
  }

  /** A caller inside a turn can be blocked by its own in-flight wait request. */
  #callerInTurn(caller: string): boolean {
    const session = this.#sessions.get(caller);
    if (session === undefined || session.isTerminal) return false;
    const status = session.view().status;
    return status === "busy" || status === "waiting_permission";
  }

  /** Path over blocking wait edges from `start` to `goal`, inclusive, or null. */
  #waitPath(start: string, goal: string): string[] | null {
    const seen = new Set<string>();
    const visit = (node: string, path: string[]): string[] | null => {
      if (node === goal) return path;
      if (seen.has(node)) return null;
      seen.add(node);
      const targets = this.#waitEdges.get(node);
      if (targets === undefined) return null;
      for (const target of targets.keys()) {
        const found = visit(target, [...path, target]);
        if (found !== null) return found;
      }
      return null;
    };
    return visit(start, [start]);
  }

  /** Hold wait edges for one request; the returned release is idempotent. */
  #holdWaitEdges(caller: string, targets: readonly string[]): () => void {
    for (const target of targets) {
      let edges = this.#waitEdges.get(caller);
      if (edges === undefined) {
        edges = new Map();
        this.#waitEdges.set(caller, edges);
      }
      edges.set(target, (edges.get(target) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const edges = this.#waitEdges.get(caller);
      if (edges === undefined) return;
      for (const target of targets) {
        const count = edges.get(target);
        if (count === undefined) continue;
        if (count <= 1) edges.delete(target);
        else edges.set(target, count - 1);
      }
      if (edges.size === 0) this.#waitEdges.delete(caller);
    };
  }

  /** A wait that already holds does not block, so it cannot close a cycle. */
  #waitSatisfiedNow(session: Session, until: WaitParams["until"]): boolean {
    if (until === "change") return false;
    const view = session.view();
    const awaitingInput =
      view.pendingPermissions.length > 0 || view.pendingElicitation !== null;
    switch (until) {
      case "idle":
        return view.status === "idle";
      case "settled":
        return (
          isTerminalStatus(view.status) || view.settled || awaitingInput
        );
      case "permission":
        return awaitingInput;
      case "exit":
        return isTerminalStatus(view.status);
    }
  }

  /**
   * A self change-wait filtered only to events emitted when a turn ends
   * cannot resolve during that same turn.
   */
  #selfChangeDeadlock(types: WaitParams["types"]): boolean {
    if (types === undefined || types.length === 0) return false;
    const afterTurn = new Set(["prompt.sent", "turn.started", "turn.ended"]);
    return types.every((type) => afterTurn.has(type));
  }

  #waitCycleError(kind: "send" | "wait", chain: string[]): HlaoError {
    const advice =
      kind === "send"
        ? "Send without --wait so the message runs after the current turn."
        : "End the turn so the queued prompt can run; a reply cannot arrive in the middle of the turn that is waiting for it.";
    return new HlaoError(
      "bad_request",
      `wait cycle: ${chain.join(" -> ")}. A message queued behind that cycle cannot start a turn. ${advice}`,
    );
  }

  async #send(params: SendParams, caller: string | null): Promise<SendResult> {
    const session = this.#resolve(params.sessionId);
    // A session inside a turn that waits for another session can deadlock when
    // the target tries to wait for a reply queued behind the caller's turn.
    // The self-send case is already rejected by Session.send.
    const blocking =
      params.wait === true &&
      caller !== null &&
      caller !== session.id &&
      this.#callerInTurn(caller);
    let release: (() => void) | undefined;
    if (blocking) {
      const path = this.#waitPath(session.id, caller);
      if (path !== null) throw this.#waitCycleError("send", [caller, ...path]);
      release = this.#holdWaitEdges(caller, [session.id]);
    }
    try {
      const sent = await session.send(
        params.text,
        params.wait ?? false,
        params.timeoutMs ?? this.#config.sendWaitTimeoutMs,
        actor(caller),
        {
          ...(params.messageId !== undefined ? { messageId: params.messageId } : {}),
          ...(params.idempotencyKey !== undefined
            ? { idempotencyKey: params.idempotencyKey }
            : {}),
          ...(params.steer !== undefined ? { steer: params.steer } : {}),
        },
      );
      return {
        session: session.view(),
        messageId: sent.messageId,
        queued: sent.queued,
        ...(sent.steered !== undefined ? { steered: sent.steered } : {}),
        ...(sent.pending !== undefined ? { pending: sent.pending } : {}),
        turn: sent.turn,
        completed: sent.completed,
        timedOut: sent.timedOut,
        stopReason: sent.stopReason,
        text: sent.text,
        ...(sent.outcome !== undefined ? { outcome: sent.outcome } : {}),
        ...(sent.duplicate !== undefined ? { duplicate: sent.duplicate } : {}),
      };
    } finally {
      release?.();
    }
  }

  #read(params: ReadParams): ReadResult {
    const session = this.#resolve(params.sessionId);
    const read = session.read({
      since: params.since,
      before: params.before,
      limit: params.limit ?? 100,
      raw: params.raw ?? false,
      types: params.types,
      turn: params.turn,
      grep: params.grep,
      afterAt: params.afterAt === undefined ? undefined : Date.parse(params.afterAt),
      beforeAt:
        params.beforeAt === undefined ? undefined : Date.parse(params.beforeAt),
      regex: params.regex,
      context: params.context,
    });
    return {
      session: session.view(),
      events: read.events,
      earliestRetainedSeq: read.earliestRetainedSeq,
      lastSeq: read.lastSeq,
      nextSeq: read.nextSeq,
      nextBefore: read.nextBefore,
      hasMore: read.hasMore,
      truncated: read.truncated,
      ...(read.matchedSeqs !== undefined ? { matchedSeqs: read.matchedSeqs } : {}),
    };
  }

  async #wait(
    params: WaitParams,
    signal: AbortSignal,
    caller: string | null,
  ): Promise<WaitResult> {
    const ids =
      params.sessionIds ?? (params.sessionId !== undefined ? [params.sessionId] : []);
    const targets = ids.map((id) => this.#resolve(id));
    const release = this.#beginWait(params, targets, caller);
    try {
      return await this.#awaitTargets(params, signal, targets);
    } finally {
      release?.();
    }
  }

  /**
   * Register a blocking wait edge, or reject a cycle. A `change` wait on
   * another session is still an edge (it cannot resolve while that session is
   * blocked on this one); a `change` wait on yourself is safe because a
   * queued prompt emits its event during the current turn.
   */
  #beginWait(
    params: WaitParams,
    targets: readonly Session[],
    caller: string | null,
  ): (() => void) | undefined {
    if (caller === null || !this.#callerInTurn(caller)) return undefined;
    const stateWait = params.until !== "change";
    const blocked = targets.filter((target) =>
      target.id === caller
        ? stateWait
          ? !this.#waitSatisfiedNow(target, params.until)
          : this.#selfChangeDeadlock(params.types)
        : this.#waitPath(target.id, caller) !== null,
    );
    const mode = params.mode ?? "any";
    const deadlocks =
      targets.length === 1
        ? blocked.length === 1
        : mode === "all"
          ? blocked.length > 0
          : blocked.length === targets.length;
    if (deadlocks) {
      const first = blocked[0]!;
      const path =
        first.id === caller
          ? [caller, caller]
          : [caller, ...this.#waitPath(first.id, caller)!];
      throw this.#waitCycleError("wait", path);
    }
    const edges = targets.map((target) => target.id).filter((id) => id !== caller);
    return this.#holdWaitEdges(caller, edges);
  }

  async #awaitTargets(
    params: WaitParams,
    signal: AbortSignal,
    targets: readonly Session[],
  ): Promise<WaitResult> {
    const timeoutMs = params.timeoutMs ?? this.#config.waitTimeoutMs;

    if (targets.length === 1) {
      const session = targets[0]!;
      const waited = await session.waitFor(
        params.until,
        params.since,
        timeoutMs,
        signal,
        params.types,
        params.grep,
      );
      const view = session.view();
      return {
        ...waited,
        results: [{ session: view, satisfied: waited.satisfied, reason: waited.reason }],
        session: view,
      };
    }

    const mode = params.mode ?? "any";
    const baselines = targets.map((target) => target.view().lastSeq);
    const startedAt = Date.now();

    return await new Promise<WaitResult>((resolve) => {
      const controller = new AbortController();
      const onRequestAbort = (): void => controller.abort();
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onRequestAbort, { once: true });

      const settled = new Map<number, WaitTargetResult>();
      let finished = false;

      const snapshot = (index: number): WaitTargetResult => {
        const target = targets[index]!;
        const view = target.view();
        const terminal = isTerminalStatus(view.status);
        switch (params.until) {
          case "idle":
            return view.status === "idle"
              ? { session: view, satisfied: true, reason: "idle" }
              : { session: view, satisfied: false, reason: terminal ? "exit" : "pending" };
          case "settled":
            if (terminal) {
              return { session: view, satisfied: true, reason: "exit" };
            }
            if (
              view.pendingPermissions.length > 0 ||
              view.pendingElicitation !== null
            ) {
              return { session: view, satisfied: true, reason: "permission" };
            }
            return view.settled
              ? { session: view, satisfied: true, reason: "idle" }
              : { session: view, satisfied: false, reason: "pending" };
          case "permission":
            return view.pendingPermissions.length > 0 ||
              view.pendingElicitation !== null
              ? { session: view, satisfied: true, reason: "permission" }
              : { session: view, satisfied: false, reason: terminal ? "exit" : "pending" };
          case "exit":
            return {
              session: view,
              satisfied: terminal,
              reason: terminal ? "exit" : "pending",
            };
          case "change": {
            const page = target.read({
              since: baselines[index] ?? 0,
              limit: 1,
              raw: false,
              types: params.types,
              grep: params.grep,
            });
            return page.events.length > 0
              ? { session: view, satisfied: true, reason: "change" }
              : { session: view, satisfied: false, reason: terminal ? "exit" : "pending" };
          }
        }
      };

      const finish = (satisfied: boolean, reason: WaitResult["reason"]): void => {
        if (finished) return;
        finished = true;
        controller.abort();
        signal.removeEventListener("abort", onRequestAbort);
        const results = targets.map((_target, index) => {
          return settled.get(index) ?? snapshot(index);
        });
        resolve({
          satisfied,
          reason,
          waitedMs: Date.now() - startedAt,
          results,
        });
      };

      const settleAll = (): void => {
        const reasons = [...settled.values()].map((entry) => entry.reason);
        const reason = reasons.every((entry) => entry === "exit") ? "exit" : "timeout";
        finish(false, reason);
      };

      targets.forEach((target, index) => {
        const since = params.until === "change" ? baselines[index] : params.since;
        void target
          .waitFor(
            params.until,
            since,
            timeoutMs,
            controller.signal,
            params.types,
            params.grep,
          )
          .then(
            (waited) => {
              settled.set(index, {
                session: target.view(),
                satisfied: waited.satisfied,
                reason: waited.reason,
              });
              if (mode === "all" && !waited.satisfied) {
                finish(false, waited.reason);
                return;
              }
              if (mode === "any" && waited.satisfied) {
                finish(true, waited.reason);
                return;
              }
              if (settled.size === targets.length) {
                if (mode === "all") {
                  const reasons = [...settled.values()].map(
                    (entry) => entry.reason,
                  );
                  // If any target ended, report that as the aggregate reason:
                  // an ended session is the fact a caller must not miss, even
                  // when another target reached the condition.
                  finish(
                    true,
                    reasons.includes("exit") ? "exit" : params.until,
                  );
                } else {
                  settleAll();
                }
              }
            },
            () => {
              settled.set(index, {
                session: target.view(),
                satisfied: false,
                reason: "timeout",
              });
              if (settled.size === targets.length) {
                if (mode === "all") finish(false, "timeout");
                else settleAll();
              }
            },
          );
      });
    });
  }

  async #cancel(params: CancelParams, caller: string | null): Promise<CancelResult> {
    const session = this.#resolve(params.sessionId);
    const { discarded } = await session.cancel(
      params.keepQueue ?? false,
      actor(caller),
    );
    return { session: session.view(), discarded };
  }

  async #close(params: CloseParams, caller: string | null): Promise<CloseResult> {
    const session = this.#resolve(params.sessionId);
    const { killed, wasTerminal } = await session.close(
      params.force ?? false,
      actor(caller),
    );
    return { session: session.view(), killed, wasTerminal };
  }

  #permit(params: PermitParams, caller: string | null): PermitResult {
    // The supervisor is the authority; the CLI pre-check is only a clear early
    // message. An agent may read pending requests but never answer one.
    if (caller !== null) {
      throw new HlaoError(
        "operator_only",
        "only an operator shell without HLAO_SESSION_ID may answer a permission request; report the blocker to the operator",
      );
    }
    const session = this.#resolve(params.sessionId);
    const resolved = session.permit(params.optionId, params.requestId, "operator");
    return {
      session: session.view(),
      requestId: resolved.requestId,
      optionId: resolved.optionId,
      by: "operator",
    };
  }

  #respondElicitation(
    params: RespondElicitationParams,
    caller: string | null,
  ): RespondElicitationResult {
    const session = this.#resolve(params.sessionId);
    const resolved = session.respondElicitation(
      params.action,
      params.content,
      params.requestId,
      actor(caller),
    );
    return {
      session: session.view(),
      requestId: resolved.requestId,
      action: resolved.action,
      by: actor(caller),
    };
  }

  async #setMode(params: SetModeParams, caller: string | null): Promise<SetModeResult> {
    if (caller !== null) {
      throw new HlaoError(
        "operator_only",
        "only an operator shell without HLAO_SESSION_ID may change a provider mode; reads stay open through sessions.get",
      );
    }
    const session = this.#resolve(params.sessionId);
    await session.setMode(params.modeId, "operator");
    return { session: session.view() };
  }

  async #setConfigOption(
    params: SetConfigOptionParams,
    caller: string | null,
  ): Promise<SetConfigOptionResult> {
    const session = this.#resolve(params.sessionId);
    await session.setConfigOption(params.configId, params.value, actor(caller));
    return { session: session.view() };
  }

  #queue(params: QueueParams): QueueResult {
    const session = this.#resolve(params.sessionId);
    const { active, queue } = session.queueView();
    return { session: session.view(), active, queue };
  }

  #queueDrop(params: QueueDropParams, caller: string | null): QueueDropResult {
    const session = this.#resolve(params.sessionId);
    const { dropped, discarded } = session.dropQueued(
      params.messageId !== undefined
        ? { messageId: params.messageId }
        : { position: params.position! },
      actor(caller),
    );
    return { session: session.view(), dropped, discarded };
  }

  #rename(params: RenameParams, caller: string | null): RenameResult {
    const session = this.#resolve(params.sessionId);
    session.setName(params.name, actor(caller));
    return { session: session.view() };
  }

  #forget(params: ForgetParams): ForgetResult {
    const session = this.#resolve(params.sessionId);
    if (!session.isTerminal) {
      throw new HlaoError(
        "bad_request",
        `session ${session.id} is still ${session.view().status}; close it before forgetting it`,
      );
    }
    const descendants = [...this.#sessions.values()].filter(
      (candidate) => candidate.parentId === session.id,
    );
    if (descendants.length > 0) {
      throw new HlaoError(
        "bad_request",
        `session ${session.id} still has ${descendants.length} retained descendant(s); forget them first`,
      );
    }
    this.#sessions.delete(session.id);
    this.#emitChange();
    this.#logger.info(`forgot ${session.id}`);
    return { sessionId: session.id, forgotten: true };
  }

  #reload(_params: ReloadParams, caller: string | null): ReloadResult {
    if (caller !== null) {
      throw new HlaoError(
        "operator_only",
        "only an operator shell without HLAO_SESSION_ID may reload config",
      );
    }
    const loaded = loadConfig(this.#home);
    this.#config = loaded.config;
    this.#configError = loaded.error ? loaded.error.message : null;
    this.#configHash = configFingerprint(this.#home);
    if (loaded.error) this.#logger.error(`config reload: ${loaded.error.message}`);
    else this.#logger.info(`config reloaded (${this.#configHash.slice(0, 12)})`);
    // Live sessions keep the config they were spawned with; only new spawns
    // see the reloaded values.
    return { configHash: this.#configHash, configError: this.#configError };
  }

  #shutdown(params: ShutdownParams, caller: string | null): ShutdownResult {
    if (caller !== null) {
      throw new HlaoError(
        "operator_only",
        "only an operator shell without HLAO_SESSION_ID may stop the supervisor",
      );
    }
    this.#acceptingNew = false;
    const sessionsClosed = [...this.#sessions.values()].filter(
      (session) => !session.isTerminal,
    ).length;
    const retainedDiscarded = [...this.#sessions.values()].filter(
      (session) => session.isTerminal,
    ).length;
    this.#shutdownAfterResponse = { force: params.force ?? false };
    return { sessionsClosed, retainedDiscarded };
  }

  // -------------------------------------------------------------------------
  // resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a session token anywhere in this instance. `callerSessionId` is
   * attribution, not scope: there is no visibility filter here (ADR 0008).
   */
  #resolve(token: string): Session {
    return resolveSession(this.#sessions, token);
  }

  #waitForInflightSpawns(timeoutMs: number): Promise<void> {
    if (this.#inflightSpawns === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.#spawnIdleResolvers.push(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }

  #sweep(): void {
    const cutoff = Date.now() - this.#config.retainClosedMs;
    let changed = false;
    for (const [id, session] of this.#sessions) {
      if (!session.isTerminal) continue;
      const endedAt = session.view().endedAt;
      if (endedAt && Date.parse(endedAt) < cutoff) {
        this.#sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.#emitChange();
  }

  // -------------------------------------------------------------------------
  // persistent streams
  // -------------------------------------------------------------------------

  /** Called after a session state change or a table change. No timer. */
  #emitChange(): void {
    for (const observer of [...this.#changeObservers]) {
      try {
        observer();
      } catch {
        // A slow or broken observer must never block the session table.
      }
    }
  }

  #subscribe(
    params: SubscribeParams,
    connection?: ConnectionState,
  ): SubscribeResult {
    if (connection === undefined || !connection.persistent) {
      throw new HlaoError(
        "bad_request",
        "stream.subscribe requires a persistent stream (hello with stream.persistent)",
      );
    }
    if (connection.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw new HlaoError(
        "too_many_requests",
        `at most ${MAX_SUBSCRIPTIONS} subscriptions may be active`,
      );
    }

    const sessionIds = (params.sessionIds ?? []).map(
      (id) => this.#resolve(id).id,
    );
    const subscription: SubscriptionState = {
      id: connection.nextSubscription,
      all: params.fleet === true,
      sessionIds: new Set(sessionIds),
      cursors: new Map(),
      lastViews: new Map(),
    };
    connection.nextSubscription += 1;

    const sessions: SessionView[] = [];
    const cursors: Record<string, number> = {};
    const truncated: string[] = [];

    for (const session of this.#subscriptionSessions(subscription)) {
      const view = session.view();
      sessions.push(view);
      const since = params.since?.[session.id];
      const cursor = since ?? view.lastSeq;
      subscription.cursors.set(session.id, cursor);
      subscription.lastViews.set(session.id, JSON.stringify(view));
      cursors[session.id] = cursor;
      if (since !== undefined && session.read({ since, limit: 1 }).truncated) {
        truncated.push(session.id);
      }
    }

    connection.subscriptions.set(subscription.id, subscription);

    return {
      subscription: subscription.id,
      sessions,
      cursors,
      truncated,
    };
  }

  #unsubscribe(
    params: UnsubscribeParams,
    connection?: ConnectionState,
  ): UnsubscribeResult {
    if (connection === undefined || !connection.persistent) {
      throw new HlaoError(
        "bad_request",
        "stream.unsubscribe requires a persistent stream",
      );
    }
    if (!connection.subscriptions.delete(params.subscription)) {
      throw new HlaoError(
        "not_found",
        `no subscription ${params.subscription} on this connection`,
      );
    }
    return { subscription: params.subscription, removed: true };
  }

  #subscriptionSessions(subscription: SubscriptionState): Session[] {
    if (subscription.all) return [...this.#sessions.values()];
    return [...subscription.sessionIds]
      .map((id) => this.#sessions.get(id))
      .filter((session): session is Session => session !== undefined);
  }

  #scheduleFlush(state: ConnectionState): void {
    if (!state.persistent || state.closed || state.flushScheduled) return;
    if (state.subscriptions.size === 0) return;
    state.flushScheduled = true;
    setImmediate(() => {
      state.flushScheduled = false;
      this.#flush(state);
    });
  }

  #flush(state: ConnectionState): void {
    if (!state.persistent || state.closed) return;
    if (state.stream.bufferedBytes() > MAX_STREAM_BUFFER_BYTES) {
      // The consumer is behind. Close it; it can resume from its cursor.
      state.closed = true;
      state.stream.terminate();
      return;
    }

    let more = false;

    for (const subscription of state.subscriptions.values()) {
      const seen = new Set<string>();

      for (const session of this.#subscriptionSessions(subscription)) {
        const id = session.id;
        seen.add(id);
        const view = session.view();
        const serialized = JSON.stringify(view);
        if (subscription.lastViews.get(id) !== serialized) {
          subscription.lastViews.set(id, serialized);
          this.#writeNotification(state, {
            type: "notification",
            subscription: subscription.id,
            kind: "session",
            session: view,
          });
        }

        if (!subscription.sessionIds.has(id)) continue;
        const cursor = subscription.cursors.get(id) ?? view.lastSeq;
        if (view.lastSeq <= cursor) continue;

        let since = cursor;
        let truncated = false;
        let pages = 0;
        while (pages < 4) {
          const page = session.read({
            since,
            limit: MAX_NOTIFICATION_EVENTS,
          });
          pages += 1;
          truncated = truncated || page.truncated;
          const last = page.events[page.events.length - 1];
          if (last === undefined) break;
          since = last.seq;
          subscription.cursors.set(id, last.seq);
          this.#writeNotification(state, {
            type: "notification",
            subscription: subscription.id,
            kind: "event",
            sessionId: id,
            events: page.events,
            cursor: last.seq,
            truncated,
          });
          if (!page.hasMore) break;
        }
        if (pages >= 4) more = true;
      }

      for (const id of [...subscription.lastViews.keys()]) {
        if (seen.has(id)) continue;
        subscription.lastViews.delete(id);
        subscription.cursors.delete(id);
        this.#writeNotification(state, {
          type: "notification",
          subscription: subscription.id,
          kind: "session.removed",
          sessionId: id,
        });
      }
    }

    if (more) this.#scheduleFlush(state);
  }

  #writeNotification(
    state: ConnectionState,
    frame: NotificationFrame,
  ): void {
    this.#write(state.stream, frame);
  }

  #write(
    stream: WireStream,
    frame: ResponseEnvelope | NotificationFrame,
  ): void {
    try {
      stream.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // The client may have vanished.
    }
  }
}


export async function runSupervisor(
  home: string,
  cliPath: string,
  version: string,
): Promise<number> {
  ensureHome(home);
  const logger = new Logger(home);
  const server = new SupervisorServer({ home, cliPath, version });

  try {
    await server.start();
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      logger.info("another supervisor is already running; exiting");
      return 0;
    }
    logger.error(`startup failed: ${describeError(error)}`);
    return 1;
  }

  logger.info(`supervisor listening on ${server.endpoint} (pid ${process.pid})`);

  const stop = (reason: string, exitCode = 0): void => {
    logger.info(`stopping: ${reason}`);
    void server.stop(false).finally(() => {
      process.exit(exitCode);
    });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error(`unhandled rejection: ${describeError(reason)}`);
  });
  process.on("uncaughtException", (error) => {
    logger.error(`uncaught exception: ${describeError(error)}`);
    stop("uncaught exception", 1);
  });

  await server.stopped;
  return 0;
}
