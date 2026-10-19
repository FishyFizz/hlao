import { isAbsolute } from "node:path";
import { HlaoError, type HlaoErrorCode } from "./errors.js";

export const WIRE_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_PROMPT_CHARS = 1_000_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1_000;

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type PermissionPolicy = "ask" | "allow" | "deny";
export type SessionStatus =
  | "starting"
  | "idle"
  | "busy"
  | "waiting_permission"
  | "closed"
  | "failed";
export type WaitUntil = "idle" | "permission" | "exit" | "change";

export type EventType =
  | "session.created"
  | "session.initialized"
  | "session.closed"
  | "session.failed"
  | "session.renamed"
  | "prompt.sent"
  | "prompt.queued"
  | "prompt.discarded"
  | "turn.started"
  | "turn.ended"
  | "cancel.requested"
  | "agent.message"
  | "agent.thought"
  | "user.message"
  | "tool.call"
  | "tool.update"
  | "plan"
  | "plan.update"
  | "permission.requested"
  | "permission.resolved"
  | "policy.changed"
  | "notice"
  | "usage"
  | "mode"
  | "config"
  | "commands"
  | "session.info"
  | "compaction"
  | "subagent"
  | "stderr"
  | "error"
  | "raw";

export interface PermissionView {
  requestId: string;
  toolCallId: string | null;
  title: string;
  kind: string | null;
  options: { optionId: string; name: string; kind: string }[];
  requestedAt: string;
}

export interface SessionModeOption {
  id: string;
  name: string;
  description?: string;
}

export interface SessionConfigValueView {
  value: string;
  name: string;
  description?: string;
  group?: string;
}

export interface SessionConfigOptionView {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  values: SessionConfigValueView[];
}

export interface SessionModes {
  currentModeId: string;
  availableModes: SessionModeOption[];
}

export interface SessionView {
  id: string;
  name: string | null;
  backend: string;
  cwd: string;
  status: SessionStatus;
  parentId: string | null;
  rootId: string;
  depth: number;
  createdAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  turn: number;
  turnStartedAt: string | null;
  queued: number;
  lastSeq: number;
  pendingPermission: PermissionView | null;
  lastStopReason: StopReason | null;
  agentSessionId: string | null;
  processId: number | null;
  exit: { code: number | null; signal: string | null } | null;
  permissionPolicy: PermissionPolicy;
  modes: SessionModes | null;
  configOptions: SessionConfigOptionView[] | null;
}

export interface EventView {
  seq: number;
  at: string;
  type: EventType;
  turn: number | null;
  data: Record<string, unknown>;
}

export interface AgentView {
  name: string;
  source: "builtin" | "user" | "project";
  command: string;
  args: string[];
  envKeys: string[];
  description?: string;
  configPath?: string;
  available: boolean;
  unavailableReason?: string;
}

export interface WireError {
  code: HlaoErrorCode;
  message: string;
  details?: unknown;
}

export interface RequestEnvelope {
  id: number;
  method: string;
  params: unknown;
  token: string;
  callerSessionId: string | null;
}

export type ResponseEnvelope =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: WireError };

export const METHODS = [
  "hello",
  "agents.list",
  "sessions.spawn",
  "sessions.list",
  "sessions.get",
  "sessions.send",
  "sessions.read",
  "sessions.wait",
  "sessions.cancel",
  "sessions.close",
  "sessions.permit",
  "sessions.set_mode",
  "sessions.set_policy",
  "sessions.set_config_option",
  "sessions.queue",
  "sessions.queue_drop",
  "sessions.rename",
  "supervisor.reload",
  "supervisor.shutdown",
] as const;

export type Method = (typeof METHODS)[number];

export interface HelloParams {}
export interface HelloResult {
  protocolVersion: number;
  pid: number;
  startedAt: string;
  version: string;
  sessions: number;
  configHash: string;
  configError?: string;
}
export interface AgentsListParams {
  cwd?: string;
}
export interface AgentsListResult {
  agents: AgentView[];
}
export interface SpawnParams {
  backend: string;
  cwd?: string;
  name?: string;
  prompt?: string;
  wait?: boolean;
  timeoutMs?: number;
  mode?: string;
  model?: string;
  config?: Record<string, string | boolean>;
  parentSessionId?: string;
  permissionPolicy?: PermissionPolicy;
  env?: Record<string, string>;
}
export interface FirstTurnResult {
  stopReason?: StopReason;
  text: string;
  timedOut: boolean;
}
export interface SpawnResult {
  session: SessionView;
  nextSeq: number;
  firstTurn?: FirstTurnResult;
}
export interface ListParams {
  includeClosed?: boolean;
  cwd?: string;
}
export interface ListResult {
  scope: "operator" | "session";
  sessions: SessionView[];
}
export interface GetParams {
  sessionId: string;
}
export interface GetResult {
  session: SessionView;
}
export interface SendParams {
  sessionId: string;
  text: string;
  wait?: boolean;
  timeoutMs?: number;
}
export interface SendResult {
  session: SessionView;
  queued: boolean;
  turn: number | null;
  completed: boolean;
  timedOut: boolean;
  stopReason?: StopReason;
  text?: string;
}
export interface ReadParams {
  sessionId: string;
  since?: number;
  limit?: number;
  raw?: boolean;
}
export interface ReadResult {
  session: SessionView;
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;
  hasMore: boolean;
  truncated: boolean;
}
export interface WaitParams {
  sessionId: string;
  until: WaitUntil;
  since?: number;
  timeoutMs?: number;
}
export interface WaitResult {
  satisfied: boolean;
  reason: WaitUntil | "timeout";
  waitedMs: number;
  session: SessionView;
}
export interface CancelParams {
  sessionId: string;
  keepQueue?: boolean;
}
export interface CancelResult {
  session: SessionView;
  discarded: number;
}
export interface CloseParams {
  sessionId: string;
  force?: boolean;
}
export interface CloseResult {
  session: SessionView;
  killed: boolean;
  wasTerminal: boolean;
}
export interface PermitParams {
  sessionId: string;
  optionId?: string;
  requestId?: string;
  always?: boolean;
}
export interface PermitResult {
  session: SessionView;
  requestId: string;
  optionId: string;
  by: string;
}
export interface SetPolicyParams {
  sessionId: string;
  permissionPolicy: PermissionPolicy;
}
export interface SetPolicyResult {
  session: SessionView;
}
export interface QueueItemView {
  position: number | null;
  textPreview: string;
  textLength: number;
  from: string;
  queuedMs: number;
  turn: number | null;
}
export interface QueueParams {
  sessionId: string;
}
export interface QueueResult {
  session: SessionView;
  active: QueueItemView | null;
  queue: QueueItemView[];
}
export interface QueueDropParams {
  sessionId: string;
  position: number;
}
export interface QueueDropResult {
  session: SessionView;
  dropped: QueueItemView;
  discarded: number;
}
export interface SetModeParams {
  sessionId: string;
  modeId: string;
}
export interface SetModeResult {
  session: SessionView;
}
export interface SetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string | boolean;
}
export interface SetConfigOptionResult {
  session: SessionView;
}
export interface RenameParams {
  sessionId: string;
  name: string | null;
}
export interface RenameResult {
  session: SessionView;
}
export interface ShutdownParams {
  force?: boolean;
}
export interface ShutdownResult {
  sessionsClosed: number;
}
export interface ReloadParams {}
export interface ReloadResult {
  configHash: string;
  configError: string | null;
}

type ParamsByMethod = {
  hello: HelloParams;
  "agents.list": AgentsListParams;
  "sessions.spawn": SpawnParams;
  "sessions.list": ListParams;
  "sessions.get": GetParams;
  "sessions.send": SendParams;
  "sessions.read": ReadParams;
  "sessions.wait": WaitParams;
  "sessions.cancel": CancelParams;
  "sessions.close": CloseParams;
  "sessions.permit": PermitParams;
  "sessions.set_mode": SetModeParams;
  "sessions.set_policy": SetPolicyParams;
  "sessions.set_config_option": SetConfigOptionParams;
  "sessions.queue": QueueParams;
  "sessions.queue_drop": QueueDropParams;
  "sessions.rename": RenameParams;
  "supervisor.reload": ReloadParams;
  "supervisor.shutdown": ShutdownParams;
};

export function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Boundary validation. Everything crossing the wire is checked here; the rest
// of the supervisor trusts the parsed value.
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HlaoError("bad_request", `${what} must be an object`);
  }
  return value as JsonObject;
}

function checkKeys(object: JsonObject, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new HlaoError("bad_request", `${what} has unknown field "${key}"`);
    }
  }
}

function reqString(
  object: JsonObject,
  key: string,
  what: string,
  min = 1,
  max = 1_000,
): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new HlaoError("bad_request", `${what}.${key} must be a string`);
  }
  if (value.length < min) {
    throw new HlaoError("bad_request", `${what}.${key} must not be empty`);
  }
  if (value.length > max) {
    throw new HlaoError("bad_request", `${what}.${key} is too long`);
  }
  return value;
}

function optString(
  object: JsonObject,
  key: string,
  what: string,
  max = 1_000,
): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HlaoError("bad_request", `${what}.${key} must be a string`);
  }
  if (value.length > max) {
    throw new HlaoError("bad_request", `${what}.${key} is too long`);
  }
  return value;
}

function optBoolean(object: JsonObject, key: string, what: string): boolean | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new HlaoError("bad_request", `${what}.${key} must be a boolean`);
  }
  return value;
}

function optInt(
  object: JsonObject,
  key: string,
  what: string,
  min: number,
  max: number,
): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HlaoError(
      "bad_request",
      `${what}.${key} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

function reqInt(
  object: JsonObject,
  key: string,
  what: string,
  min: number,
  max: number,
): number {
  const value = optInt(object, key, what, min, max);
  if (value === undefined) {
    throw new HlaoError("bad_request", `${what}.${key} is required`);
  }
  return value;
}

function optEnum<T extends string>(
  object: JsonObject,
  key: string,
  what: string,
  allowed: readonly T[],
): T | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HlaoError(
      "bad_request",
      `${what}.${key} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function reqEnum<T extends string>(
  object: JsonObject,
  key: string,
  what: string,
  allowed: readonly T[],
): T {
  const value = optEnum(object, key, what, allowed);
  if (value === undefined) {
    throw new HlaoError("bad_request", `${what}.${key} is required`);
  }
  return value;
}

function absolutePath(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) {
    throw new HlaoError("bad_request", `${what} must be an absolute path`);
  }
  return value;
}

function stringRecord(
  object: JsonObject,
  key: string,
  what: string,
): Record<string, string> | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  const record = asObject(value, `${what}.${key}`);
  const entries = Object.entries(record);
  if (entries.length > 100) {
    throw new HlaoError("bad_request", `${what}.${key} has too many entries`);
  }
  const result: Record<string, string> = {};
  for (const [name, entry] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new HlaoError("bad_request", `${what}.${key} has invalid name "${name}"`);
    }
    if (typeof entry !== "string" || entry.length > 32_768) {
      throw new HlaoError("bad_request", `${what}.${key}.${name} must be a string`);
    }
    result[name] = entry;
  }
  return result;
}

function configRecord(
  object: JsonObject,
  key: string,
  what: string,
): Record<string, string | boolean> | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  const record = asObject(value, `${what}.${key}`);
  const entries = Object.entries(record);
  if (entries.length > 50) {
    throw new HlaoError(
      "bad_request",
      `${what}.${key} must have at most 50 entries`,
    );
  }
  const result: Record<string, string | boolean> = {};
  for (const [name, entry] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
      throw new HlaoError(
        "bad_request",
        `${what}.${key} has an invalid option name "${name}"`,
      );
    }
    if (typeof entry !== "string" && typeof entry !== "boolean") {
      throw new HlaoError(
        "bad_request",
        `${what}.${key}.${name} must be a string or boolean`,
      );
    }
    if (typeof entry === "string" && entry.length > 500) {
      throw new HlaoError(
        "bad_request",
        `${what}.${key}.${name} is too long`,
      );
    }
    result[name] = entry;
  }
  return result;
}

export function parseEnvelope(value: unknown): RequestEnvelope {
  const object = asObject(value, "request");
  checkKeys(object, ["id", "method", "params", "token", "callerSessionId"], "request");

  const id = object.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    throw new HlaoError("bad_request", "request.id must be a non-negative integer");
  }
  const method = reqString(object, "method", "request", 1, 100);
  const token = reqString(object, "token", "request", 1, 512);

  let callerSessionId: string | null = null;
  const rawCaller = object.callerSessionId;
  if (rawCaller !== undefined && rawCaller !== null) {
    if (typeof rawCaller !== "string" || rawCaller.length === 0 || rawCaller.length > 64) {
      throw new HlaoError("bad_request", "request.callerSessionId must be a session id");
    }
    callerSessionId = rawCaller;
  }

  return {
    id,
    method,
    params: object.params ?? {},
    token,
    callerSessionId,
  };
}

export function parseParams<M extends Method>(method: M, raw: unknown): ParamsByMethod[M] {
  const what = method;
  switch (method) {
    case "hello": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, [], what);
      return object as HelloParams as ParamsByMethod[M];
    }
    case "agents.list": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, ["cwd"], what);
      return {
        cwd: absolutePath(optString(object, "cwd", what, 1_000), `${what}.cwd`),
      } as ParamsByMethod[M];
    }
    case "sessions.spawn": {
      const object = asObject(raw, what);
      checkKeys(
        object,
        [
          "backend",
          "cwd",
          "name",
          "prompt",
          "wait",
          "timeoutMs",
          "mode",
          "model",
          "config",
          "parentSessionId",
          "permissionPolicy",
          "env",
        ],
        what,
      );
      const prompt = optString(object, "prompt", what, MAX_PROMPT_CHARS);
      if (prompt !== undefined && prompt.length === 0) {
        throw new HlaoError("bad_request", `${what}.prompt must not be empty`);
      }
      return {
        backend: reqString(object, "backend", what, 1, 200),
        cwd: absolutePath(optString(object, "cwd", what, 1_000), `${what}.cwd`),
        name: optString(object, "name", what, 200),
        prompt,
        wait: optBoolean(object, "wait", what),
        timeoutMs: optInt(object, "timeoutMs", what, 0, MAX_TIMEOUT_MS),
        mode: optString(object, "mode", what, 100),
        model: optString(object, "model", what, 200),
        config: configRecord(object, "config", what),
        parentSessionId: optString(object, "parentSessionId", what, 64),
        permissionPolicy: optEnum(object, "permissionPolicy", what, [
          "ask",
          "allow",
          "deny",
        ] as const),
        env: stringRecord(object, "env", what),
      } as ParamsByMethod[M];
    }
    case "sessions.list": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, ["includeClosed", "cwd"], what);
      return {
        includeClosed: optBoolean(object, "includeClosed", what),
        cwd: absolutePath(optString(object, "cwd", what, 1_000), `${what}.cwd`),
      } as ParamsByMethod[M];
    }
    case "sessions.get": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
      } as ParamsByMethod[M];
    }
    case "sessions.cancel": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "keepQueue"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        keepQueue: optBoolean(object, "keepQueue", what),
      } as ParamsByMethod[M];
    }
    case "sessions.send": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "text", "wait", "timeoutMs"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        text: reqString(object, "text", what, 1, MAX_PROMPT_CHARS),
        wait: optBoolean(object, "wait", what),
        timeoutMs: optInt(object, "timeoutMs", what, 0, MAX_TIMEOUT_MS),
      } as ParamsByMethod[M];
    }
    case "sessions.read": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "since", "limit", "raw"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        since: optInt(object, "since", what, 0, Number.MAX_SAFE_INTEGER),
        limit: optInt(object, "limit", what, 1, 1_000),
        raw: optBoolean(object, "raw", what),
      } as ParamsByMethod[M];
    }
    case "sessions.wait": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "until", "since", "timeoutMs"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        until:
          optEnum(object, "until", what, ["idle", "permission", "exit", "change"] as const) ??
          "idle",
        since: optInt(object, "since", what, 0, Number.MAX_SAFE_INTEGER),
        timeoutMs: optInt(object, "timeoutMs", what, 0, MAX_TIMEOUT_MS),
      } as ParamsByMethod[M];
    }
    case "sessions.close": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "force"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        force: optBoolean(object, "force", what),
      } as ParamsByMethod[M];
    }
    case "sessions.permit": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "optionId", "requestId", "always"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        optionId: optString(object, "optionId", what, 500),
        requestId: optString(object, "requestId", what, 200),
        always: optBoolean(object, "always", what),
      } as ParamsByMethod[M];
    }
    case "sessions.set_mode": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "modeId"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        modeId: reqString(object, "modeId", what, 1, 100),
      } as ParamsByMethod[M];
    }
    case "sessions.set_policy": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "permissionPolicy"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        permissionPolicy: reqEnum(object, "permissionPolicy", what, [
          "ask",
          "allow",
          "deny",
        ] as const),
      } as ParamsByMethod[M];
    }
    case "sessions.set_config_option": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "configId", "value"], what);
      const value = object.value;
      if (typeof value !== "string" && typeof value !== "boolean") {
        throw new HlaoError(
          "bad_request",
          `${what}.value must be a string or boolean`,
        );
      }
      if (typeof value === "string" && value.length > 500) {
        throw new HlaoError(
          "bad_request",
          `${what}.value must be at most 500 characters`,
        );
      }
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        configId: reqString(object, "configId", what, 1, 100),
        value,
      } as ParamsByMethod[M];
    }
    case "sessions.queue": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
      } as ParamsByMethod[M];
    }
    case "sessions.queue_drop": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "position"], what);
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        position: reqInt(object, "position", what, 1, 1_000),
      } as ParamsByMethod[M];
    }
    case "sessions.rename": {
      const object = asObject(raw, what);
      checkKeys(object, ["sessionId", "name"], what);
      if (!("name" in object)) {
        throw new HlaoError("bad_request", `${what}.name is required (use null to clear)`);
      }
      const name = object.name;
      if (
        name !== null &&
        (typeof name !== "string" || name.trim().length === 0 || name.length > 200)
      ) {
        throw new HlaoError(
          "bad_request",
          `${what}.name must be a non-empty string of at most 200 characters, or null`,
        );
      }
      return {
        sessionId: reqString(object, "sessionId", what, 1, 64),
        name: name as string | null,
      } as ParamsByMethod[M];
    }
    case "supervisor.reload": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, [], what);
      return object as ReloadParams as ParamsByMethod[M];
    }
    case "supervisor.shutdown": {
      const object = asObject(raw ?? {}, what);
      checkKeys(object, ["force"], what);
      return {
        force: optBoolean(object, "force", what),
      } as ParamsByMethod[M];
    }
    default: {
      const unreachable: never = method;
      throw new HlaoError("bad_request", `unknown method ${String(unreachable)}`);
    }
  }
}
