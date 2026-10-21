import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import {
  configFingerprint,
  loadConfig,
  type HlaoConfig,
} from "./config.js";
import { clearCrashMarker, readCrashMarker, writeCrashMarker } from "./crash.js";
import { HlaoError, describeError } from "./errors.js";
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
import { evaluateWait } from "./session/waits.js";
import { resolveSession } from "./supervisor/resolve.js";
import {
  listBackends,
  providerSessionCatalog,
  recoveryReceipts,
} from "./supervisor/discovery.js";
import { SpawnService } from "./supervisor/spawn.js";
import {
  actor,
  delay,
  modeConfigOperatorOnlyError,
  pathKey,
} from "./supervisor/util.js";
import { WaitGraph, waitCycleError } from "./supervisor/wait-graph.js";
import { awaitWaitTargets } from "./supervisor/waits.js";
import { ensureHomeSkill } from "./skill.js";
import { nowIso } from "./time.js";
import {
  ConnectionHub,
  type ConnectionHandle,
  type SubscriptionScope,
} from "./supervisor/connections.js";
import {
  createWireServer,
  pathTarget,
  type WireStreamServer,
} from "./stream.js";
import {
  PROTOCOL_CAPABILITIES,
  WIRE_PROTOCOL_MAJOR,
  WIRE_PROTOCOL_VERSION,
  isMethod,
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
  type PermitParams,
  type PermitResult,
  type ProviderSessionsParams,
  type ProviderSessionsResult,
  type RecoveryReceiptsParams,
  type RecoveryReceiptsResult,
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
  type SendParams,
  type SendResult,
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
  type UnsubscribeParams,
  type WaitParams,
  type WaitResult,
} from "./protocol.js";
import { isTerminalStatus } from "./protocol.js";
import { Session } from "./session.js";

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
  /** Blocking cross-session waits held by in-flight requests. */
  #waits = new WaitGraph();
  #spawner: SpawnService;
  #connections: ConnectionHub;
  #server: WireStreamServer | null = null;
  #lock: LockInfo | null = null;
  #stopping = false;
  #acceptingNew = true;
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
    this.#spawner = new SpawnService({
      home: this.#home,
      cliPath: this.#cliPath,
      sessions: this.#sessions,
      config: () => this.#config,
      acceptingNew: () => this.#acceptingNew,
      resolve: (token) => this.#resolve(token),
      logger: this.#logger,
      emitChange: () => this.#emitChange(),
    });
    this.#connections = new ConnectionHub({
      handle: (envelope, signal, connection) =>
        this.#handleEnvelope(envelope, signal, connection),
      resolveSessionIds: (ids) => ids.map((id) => this.#resolve(id).id),
      subscriptionSessions: (scope) => this.#subscriptionSessions(scope),
      afterResponse: () => this.#afterResponse(),
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
      server.onConnection((stream) => this.#connections.accept(stream));
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
    await this.#spawner.whenIdle(5_000);

    const live = [...this.#sessions.values()].filter((session) => !session.isTerminal);
    await Promise.allSettled(live.map((session) => session.close(force)));

    this.#connections.close();

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

  async #handleEnvelope(
    envelope: RequestEnvelope,
    signal: AbortSignal,
    connection: ConnectionHandle,
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
      case "recovery.receipts":
        return this.#recoveryReceipts(params as RecoveryReceiptsParams);
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
        return connection.subscribe(params as SubscribeParams);
      case "stream.unsubscribe":
        return connection.unsubscribe(params as UnsubscribeParams);
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

  #spawn(params: SpawnParams, caller: string | null): Promise<SpawnResult> {
    return this.#spawner.spawn(params, caller);
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

  /** Backend discovery for any client. */
  #backends(params: BackendsListParams, caller: string | null): BackendsListResult {
    if (this.#configError !== null) {
      throw new HlaoError("config_invalid", this.#configError);
    }
    const callerSession = caller !== null ? this.#sessions.get(caller) : undefined;
    const cwd = params.cwd ?? callerSession?.cwd ?? process.cwd();
    return listBackends(this.#config, cwd);
  }

  /** Historical spawn receipts, live-joined: never liveness. */
  #recoveryReceipts(params: RecoveryReceiptsParams): RecoveryReceiptsResult {
    return recoveryReceipts(this.#home, this.#sessions, params);
  }

  /**
   * Read the provider's own session catalog and join it to the live table.
   * The provider owns the rows; the live join answers only whether this
   * instance currently drives each row.
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
    return providerSessionCatalog({
      config: this.#config,
      sessions: this.#sessions,
      params,
      cwd: mergeCwd,
      signal,
      timeoutMs: this.#config.startupTimeoutMs,
      log: (line) => this.#logger.info(line),
    });
  }

  /** A caller inside a turn can be blocked by its own in-flight wait request. */
  #callerInTurn(caller: string): boolean {
    const session = this.#sessions.get(caller);
    if (session === undefined || session.isTerminal) return false;
    const status = session.view().status;
    return status === "busy" || status === "waiting_permission";
  }

  /** A wait that already holds does not block, so it cannot close a cycle. */
  #waitSatisfiedNow(session: Session, until: WaitParams["until"]): boolean {
    if (until === "change") return false;
    const view = session.view();
    return evaluateWait(until, {
      status: view.status,
      queued: view.queued,
      awaitingInput:
        view.pendingPermissions.length > 0 || view.pendingElicitation !== null,
      terminal: isTerminalStatus(view.status),
    }).satisfied;
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
      const path = this.#waits.path(session.id, caller);
      if (path !== null) throw waitCycleError("send", [caller, ...path]);
      release = this.#waits.hold(caller, [session.id]);
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
        : this.#waits.path(target.id, caller) !== null,
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
          : [caller, ...this.#waits.path(first.id, caller)!];
      throw waitCycleError("wait", path);
    }
    const edges = targets.map((target) => target.id).filter((id) => id !== caller);
    return this.#waits.hold(caller, edges);
  }

  #awaitTargets(
    params: WaitParams,
    signal: AbortSignal,
    targets: readonly Session[],
  ): Promise<WaitResult> {
    return awaitWaitTargets(params, signal, targets, this.#config.waitTimeoutMs);
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
    // A mode config option is a mode change; `option <id> mode …` may not do
    // what `mode` and spawn `--mode` refuse.
    if (caller !== null && session.isModeConfigOption(params.configId)) {
      throw modeConfigOperatorOnlyError(params.configId);
    }
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
    this.#connections.notifyChange();
  }

  #subscriptionSessions(scope: SubscriptionScope): Session[] {
    if (scope.all) return [...this.#sessions.values()];
    return [...scope.sessionIds]
      .map((id) => this.#sessions.get(id))
      .filter((session): session is Session => session !== undefined);
  }

  /** A shutdown waits for the response that requested it to be written. */
  #afterResponse(): void {
    const shutdown = this.#shutdownAfterResponse;
    if (!shutdown) return;
    this.#shutdownAfterResponse = null;
    setImmediate(() => {
      void this.stop(shutdown.force);
    });
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
