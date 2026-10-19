import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import {
  configFingerprint,
  loadConfig,
  mergeBackends,
  toAgentView,
  type HlaoConfig,
} from "./config.js";
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
import {
  MAX_FRAME_BYTES,
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
  type ListParams,
  type ListResult,
  type PermitParams,
  type PermitResult,
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
  type RenameParams,
  type RenameResult,
  type SetConfigOptionParams,
  type SetConfigOptionResult,
  type SetModeParams,
  type SetModeResult,
  type SetPolicyParams,
  type SetPolicyResult,
  type ShutdownParams,
  type ShutdownResult,
  type SpawnParams,
  type SpawnResult,
  type WaitParams,
  type WaitResult,
  type WaitTargetResult,
} from "./protocol.js";
import { Session } from "./session.js";

function actor(caller: string | null): string {
  return caller ?? "operator";
}

export class AlreadyRunningError extends Error {
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

export class SupervisorServer {
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
  #sessions = new Map<string, Session>();
  #server: Server | null = null;
  #sockets = new Set<Socket>();
  #lock: LockInfo | null = null;
  #stopping = false;
  #acceptingNew = true;
  #inflightSpawns = 0;
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
    ensureHome(this.#home);
    await this.#acquireLock();

    try {
      if (!isWindows() && existsSync(this.endpoint)) {
        try {
          unlinkSync(this.endpoint);
        } catch {
          // Best effort; listen will report a real conflict.
        }
      }

      const server = createServer((socket) => this.#onConnection(socket));
      this.#server = server;
      server.on("error", (error) => {
        this.#logger.error(`server error: ${describeError(error)}`);
      });

      await new Promise<void>((resolvePromise, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(
            new HlaoError(
              "internal",
              `cannot listen on ${this.endpoint}: ${describeError(error)}`,
            ),
          );
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolvePromise();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.endpoint);
      });

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

    for (const socket of this.#sockets) {
      if (!socket.writableEnded) socket.destroy();
    }

    if (this.#server) {
      await new Promise<void>((resolveStop) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolveStop();
        };
        this.#server!.close(() => finish());
        const fallback = setTimeout(() => {
          try {
            (
              this.#server as unknown as { closeAllConnections?: () => void }
            ).closeAllConnections?.();
          } catch {
            // Older runtimes.
          }
          finish();
        }, 2_000);
        fallback.unref?.();
      });
    }

    removeLock(this.#home, this.token);
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

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = readLock(this.#home);
      if (existing) {
        if (existing.pid === process.pid) {
          // A lock left by this pid but a different token: ours is mid-write.
          removeLock(this.#home, existing.token);
        } else if (pidAlive(existing.pid)) {
          const age = Date.now() - Date.parse(existing.startedAt);
          if (Number.isFinite(age) && age < 30_000) {
            throw new AlreadyRunningError(existing);
          }
          if (await probeSupervisor(existing)) {
            throw new AlreadyRunningError(existing);
          }
          removeLock(this.#home, existing.token);
        } else {
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
        this.#lock = info;
        return;
      }
    }

    const owner = readLock(this.#home);
    if (owner) throw new AlreadyRunningError(owner);
    throw new HlaoError("internal", "could not acquire the supervisor lock");
  }

  // -------------------------------------------------------------------------
  // connections
  // -------------------------------------------------------------------------

  #onConnection(socket: Socket): void {
    this.#sockets.add(socket);
    const abort = new AbortController();
    socket.setEncoding("utf8");
    socket.on("error", () => abort.abort());
    socket.on("close", () => {
      abort.abort();
      this.#sockets.delete(socket);
    });

    let buffer = "";
    let handled = false;
    const initialTimer = setTimeout(() => {
      if (!handled) socket.destroy();
    }, 15_000);
    initialTimer.unref?.();

    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        handled = true;
        clearTimeout(initialTimer);
        this.#write(socket, failure(0, new HlaoError("bad_request", "request frame too large")));
        socket.end();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      clearTimeout(initialTimer);
      const line = buffer.slice(0, newline);
      void this.#handleLine(line, socket, abort.signal);
    });
  }

  async #handleLine(line: string, socket: Socket, signal: AbortSignal): Promise<void> {
    let id = 0;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new HlaoError("bad_request", "request is not valid JSON");
      }
      const envelope = parseEnvelope(parsed);
      id = envelope.id;
      await this.#handleEnvelope(envelope, signal).then(
        (result) => this.#write(socket, { id, ok: true, result }),
        (error) => this.#write(socket, failure(id, error)),
      );
    } catch (error) {
      this.#write(socket, failure(id, error));
    }

    socket.end();
    const shutdown = this.#shutdownAfterResponse;
    if (shutdown) {
      this.#shutdownAfterResponse = null;
      setImmediate(() => {
        void this.stop(shutdown.force);
      });
    }
  }

  async #handleEnvelope(envelope: RequestEnvelope, signal: AbortSignal): Promise<unknown> {
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
        };
        return result;
      }
      case "backends.list":
        return this.#backends(params as BackendsListParams, caller);
      case "sessions.spawn":
        return this.#spawn(params as SpawnParams, caller);
      case "sessions.list":
        return this.#list(params as ListParams, caller);
      case "sessions.get":
        return this.#get(params as GetParams, caller);
      case "sessions.send":
        return this.#send(params as SendParams, caller);
      case "sessions.read":
        return this.#read(params as ReadParams, caller);
      case "sessions.wait":
        return this.#wait(params as WaitParams, caller, signal);
      case "sessions.cancel":
        return this.#cancel(params as CancelParams, caller);
      case "sessions.close":
        return this.#close(params as CloseParams, caller);
      case "sessions.permit":
        return this.#permit(params as PermitParams, caller);
      case "sessions.set_mode":
        return this.#setMode(params as SetModeParams, caller);
      case "sessions.set_policy":
        return this.#setPolicy(params as SetPolicyParams, caller);
      case "sessions.set_config_option":
        return this.#setConfigOption(params as SetConfigOptionParams, caller);
      case "sessions.queue":
        return this.#queue(params as QueueParams, caller);
      case "sessions.queue_drop":
        return this.#queueDrop(params as QueueDropParams, caller);
      case "sessions.rename":
        return this.#rename(params as RenameParams, caller);
      case "sessions.forget":
        return this.#forget(params as ForgetParams, caller);
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
    this.#inflightSpawns += 1;
    try {
      return await this.#spawnInner(params, caller);
    } finally {
      this.#inflightSpawns -= 1;
      if (this.#inflightSpawns === 0) {
        for (const resolve of this.#spawnIdleResolvers.splice(0)) resolve();
      }
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

    let parent: Session | null = null;
    if (params.parentSessionId !== undefined) {
      parent = this.#resolve(caller, params.parentSessionId);
    } else if (caller !== null) {
      parent = this.#sessions.get(caller) ?? null;
      if (!parent) {
        throw new HlaoError(
          "forbidden",
          `caller session ${caller} is not live; cannot derive a parent`,
        );
      }
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
    const policy = params.permissionPolicy ?? this.#config.permissionPolicy;

    const session = await Session.spawn({
      id,
      backend,
      cwd,
      parentId: parent?.id ?? null,
      rootId,
      depth,
      name: params.name ?? null,
      requestedMode: params.mode,
      env: params.env ?? {},
      permissionPolicy: policy,
      home: this.#home,
      config: {
        startupTimeoutMs: this.#config.startupTimeoutMs,
        maxEventsPerSession: this.#config.maxEventsPerSession,
        maxEventLogBytes: this.#config.maxEventLogBytes,
        maxEventBytes: this.#config.maxEventBytes,
      },
      cliPath: this.#cliPath,
      log: (line) => this.#logger.info(line),
    });

    if (!this.#acceptingNew) {
      await session.close(true);
      throw new HlaoError("session_closed", "the supervisor is shutting down");
    }

    if (params.mode !== undefined) {
      try {
        await session.setMode(params.mode, actor(caller));
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
    this.#logger.info(
      `spawned ${id} (${backend.name}) in ${cwd}${parent ? ` parent=${parent.id}` : ""}`,
    );

    const result: SpawnResult = {
      session: session.view(),
      nextSeq: 0,
    };

    if (params.prompt !== undefined) {
      try {
        const sent = await session.send(
          params.prompt,
          params.wait ?? false,
          params.timeoutMs ?? this.#config.sendWaitTimeoutMs,
          actor(caller),
        );
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

  #list(params: ListParams, caller: string | null): ListResult {
    let sessions = this.#visible(caller);
    if (!params.includeClosed) {
      sessions = sessions.filter((session) => session.view().status !== "closed");
    }
    if (params.cwd !== undefined) {
      sessions = sessions.filter((session) => resolve(session.cwd) === resolve(params.cwd!));
    }
    sessions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      scope: caller === null ? "operator" : "session",
      sessions: sessions.map((session) => session.view()),
    };
  }

  #get(params: GetParams, caller: string | null): GetResult {
    return { session: this.#resolve(caller, params.sessionId).view() };
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

  async #send(params: SendParams, caller: string | null): Promise<SendResult> {
    const session = this.#resolveSendTarget(caller, params.sessionId);
    const sent = await session.send(
      params.text,
      params.wait ?? false,
      params.timeoutMs ?? this.#config.sendWaitTimeoutMs,
      actor(caller),
    );
    return {
      session: session.view(),
      queued: sent.queued,
      turn: sent.turn,
      completed: sent.completed,
      timedOut: sent.timedOut,
      stopReason: sent.stopReason,
      text: sent.text,
    };
  }

  #read(params: ReadParams, caller: string | null): ReadResult {
    const session = this.#resolve(caller, params.sessionId);
    const read = session.read({
      since: params.since,
      before: params.before,
      limit: params.limit ?? 100,
      raw: params.raw ?? false,
      types: params.types,
      turn: params.turn,
      grep: params.grep,
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
    };
  }

  async #wait(
    params: WaitParams,
    caller: string | null,
    signal: AbortSignal,
  ): Promise<WaitResult> {
    const ids =
      params.sessionIds ?? (params.sessionId !== undefined ? [params.sessionId] : []);
    const targets = ids.map((id) => this.#resolve(caller, id));
    const timeoutMs = params.timeoutMs ?? this.#config.waitTimeoutMs;

    if (targets.length === 1) {
      const session = targets[0]!;
      const waited = await session.waitFor(params.until, params.since, timeoutMs, signal);
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
        const terminal = view.status === "closed" || view.status === "failed";
        switch (params.until) {
          case "idle":
            return view.status === "idle"
              ? { session: view, satisfied: true, reason: "idle" }
              : { session: view, satisfied: false, reason: terminal ? "exit" : "pending" };
          case "permission":
            return view.pendingPermission !== null
              ? { session: view, satisfied: true, reason: "permission" }
              : { session: view, satisfied: false, reason: terminal ? "exit" : "pending" };
          case "exit":
            return {
              session: view,
              satisfied: terminal,
              reason: terminal ? "exit" : "pending",
            };
          case "change":
            return view.lastSeq > (baselines[index] ?? 0)
              ? { session: view, satisfied: true, reason: "change" }
              : { session: view, satisfied: false, reason: terminal ? "exit" : "pending" };
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
          .waitFor(params.until, since, timeoutMs, controller.signal)
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
                if (mode === "all") finish(true, params.until);
                else settleAll();
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
    const session = this.#resolve(caller, params.sessionId);
    const { discarded } = await session.cancel(
      params.keepQueue ?? false,
      actor(caller),
    );
    return { session: session.view(), discarded };
  }

  async #close(params: CloseParams, caller: string | null): Promise<CloseResult> {
    const session = this.#resolve(caller, params.sessionId);
    const { killed, wasTerminal } = await session.close(
      params.force ?? false,
      actor(caller),
    );
    return { session: session.view(), killed, wasTerminal };
  }

  #permit(params: PermitParams, caller: string | null): PermitResult {
    const session = this.#resolve(caller, params.sessionId);
    const resolved = session.permit(
      params.optionId,
      params.requestId,
      params.always ?? false,
      actor(caller),
    );
    return {
      session: session.view(),
      requestId: resolved.requestId,
      optionId: resolved.optionId,
      by: actor(caller),
    };
  }

  async #setMode(params: SetModeParams, caller: string | null): Promise<SetModeResult> {
    const session = this.#resolve(caller, params.sessionId);
    await session.setMode(params.modeId, actor(caller));
    return { session: session.view() };
  }

  #setPolicy(params: SetPolicyParams, caller: string | null): SetPolicyResult {
    const session = this.#resolve(caller, params.sessionId);
    session.setPolicy(params.permissionPolicy, actor(caller));
    return { session: session.view() };
  }

  async #setConfigOption(
    params: SetConfigOptionParams,
    caller: string | null,
  ): Promise<SetConfigOptionResult> {
    const session = this.#resolve(caller, params.sessionId);
    await session.setConfigOption(params.configId, params.value, actor(caller));
    return { session: session.view() };
  }

  #queue(params: QueueParams, caller: string | null): QueueResult {
    const session = this.#resolve(caller, params.sessionId);
    const { active, queue } = session.queueView();
    return { session: session.view(), active, queue };
  }

  #queueDrop(params: QueueDropParams, caller: string | null): QueueDropResult {
    const session = this.#resolve(caller, params.sessionId);
    const { dropped, discarded } = session.dropQueued(
      params.position,
      actor(caller),
    );
    return { session: session.view(), dropped, discarded };
  }

  #rename(params: RenameParams, caller: string | null): RenameResult {
    const session = this.#resolve(caller, params.sessionId);
    session.setName(params.name, actor(caller));
    return { session: session.view() };
  }

  #forget(params: ForgetParams, caller: string | null): ForgetResult {
    const session = this.#resolve(caller, params.sessionId);
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
    this.#shutdownAfterResponse = { force: params.force ?? false };
    return { sessionsClosed };
  }

  // -------------------------------------------------------------------------
  // scope and resolution
  // -------------------------------------------------------------------------

  #visible(caller: string | null): Session[] {
    const all = [...this.#sessions.values()];
    if (caller === null) return all;

    const self = this.#sessions.get(caller);
    if (!self) return [];
    const allowed = new Set<string>([self.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of all) {
        if (
          session.parentId !== null &&
          allowed.has(session.parentId) &&
          !allowed.has(session.id)
        ) {
          allowed.add(session.id);
          changed = true;
        }
      }
    }
    return all.filter((session) => allowed.has(session.id));
  }

  /**
   * The one deliberate exception to visibility: a session may send a message
   * to its direct parent, so a finding or a blocking question can travel upward.
   * Reads, waits, cancel, close, and permit remain forbidden on ancestors.
   */
  #resolveSendTarget(caller: string | null, token: string): Session {
    try {
      return this.#resolve(caller, token);
    } catch (error) {
      if (caller === null) throw error;
      const self = this.#sessions.get(caller);
      const parent = self?.parentId
        ? this.#sessions.get(self.parentId)
        : undefined;
      if (!parent) throw error;
      if (token === parent.id || token === parent.name) return parent;
      const prefixMatches = [...this.#sessions.values()].filter((session) =>
        session.id.startsWith(token),
      );
      if (prefixMatches.length === 1 && prefixMatches[0] === parent) {
        return parent;
      }
      throw error;
    }
  }

  #resolve(caller: string | null, token: string): Session {
    const scope = this.#visible(caller);
    const exact = this.#sessions.get(token);
    if (exact) {
      if (!scope.some((session) => session.id === exact.id)) {
        throw new HlaoError(
          "forbidden",
          `session ${token} is outside the caller's scope`,
        );
      }
      return exact;
    }

    const nameMatches = scope.filter((session) => session.name === token);
    if (nameMatches.length === 1) return nameMatches[0]!;
    if (nameMatches.length > 1) {
      throw new HlaoError(
        "ambiguous_id",
        `session name "${token}" matches ${nameMatches.length} sessions`,
        {
          candidates: nameMatches.map((session) => {
            const view = session.view();
            return { id: view.id, name: view.name, status: view.status };
          }),
        },
      );
    }

    const matches = scope.filter((session) => session.id.startsWith(token));
    if (matches.length === 0) {
      throw new HlaoError("not_found", `no session matching "${token}"`);
    }
    if (matches.length > 1) {
      throw new HlaoError(
        "ambiguous_id",
        `session prefix "${token}" matches ${matches.length} sessions`,
        {
          candidates: matches.map((session) => {
            const view = session.view();
            return { id: view.id, name: view.name, status: view.status };
          }),
        },
      );
    }
    return matches[0]!;
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
    for (const [id, session] of this.#sessions) {
      if (!session.isTerminal) continue;
      const endedAt = session.view().endedAt;
      if (endedAt && Date.parse(endedAt) < cutoff) {
        this.#sessions.delete(id);
      }
    }
  }

  #write(socket: Socket, response: ResponseEnvelope): void {
    if (socket.destroyed) return;
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } catch {
      // The client may have vanished.
    }
  }
}

function failure(id: number, error: unknown): ResponseEnvelope {
  const converted = toHlaoError(error);
  return {
    id,
    ok: false,
    error: {
      code: converted.code,
      message: converted.message,
      ...(converted.details !== undefined ? { details: converted.details } : {}),
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
