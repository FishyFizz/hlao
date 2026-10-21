import type { HlaoErrorCode } from "../errors.js";
import type { ProtocolCapability, ProtocolVersion } from "./version.js";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type SessionStatus =
  | "starting"
  | "idle"
  | "busy"
  | "waiting_permission"
  | "closed"
  | "failed";

/** A session in a terminal state can never run another turn. */
export function isTerminalStatus(status: SessionStatus): boolean {
  return status === "closed" || status === "failed";
}

export type WaitUntil = "idle" | "settled" | "permission" | "exit" | "change";

export const EVENT_TYPES = [
  "session.created",
  "session.initialized",
  "session.resumed",
  "session.forked",
  "session.closed",
  "session.failed",
  "session.renamed",
  "prompt.sent",
  "prompt.queued",
  "prompt.steered",
  "prompt.discarded",
  "turn.started",
  "turn.ended",
  "cancel.requested",
  "agent.message",
  "agent.thought",
  "user.message",
  "session.message",
  "tool.call",
  "tool.update",
  "plan",
  "plan.update",
  "permission.requested",
  "permission.resolved",
  "elicitation.requested",
  "elicitation.resolved",
  "notice",
  "usage",
  "mode",
  "config",
  "commands",
  "session.info",
  "compaction",
  "subagent",
  "stderr",
  "error",
  "raw",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface PermissionView {
  requestId: string;
  toolCallId: string | null;
  title: string;
  kind: string | null;
  options: { optionId: string; name: string; kind: string }[];
  requestedAt: string;
}

/** A provider request for structured user input (form or URL). */
export interface ElicitationView {
  requestId: string;
  toolCallId: string | null;
  message: string;
  /** `"form"` for a `requestedSchema`, `"url"` for a URL elicitation. */
  mode: string;
  /** Form mode: a JSON Schema object describing the fields to render. */
  requestedSchema?: Record<string, unknown>;
  /** URL mode: where the user must go. */
  url?: string;
  /** URL mode: the provider's identifier for this elicitation. */
  elicitationId?: string;
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

export interface SessionUsageView {
  used: number;
  size: number;
  cost: { amount: number; currency: string } | null;
  /** When the snapshot was observed (the `usage` event's timestamp). */
  at: string;
}

/** The latest provider compaction, projected from ACP compaction updates. */
export interface SessionCompactionView {
  id: string;
  status: string;
  summary: string | null;
  error: string | null;
  updatedAt: string;
}

export interface SessionPlanEntryView {
  content: string;
  priority: string;
  status: string;
}

/**
 * The latest provider plan. A full ACP `plan` update has no plan ID, so
 * `planId` is null for that form; deltas and removals carry the provider ID.
 */
export interface SessionPlanView {
  planId: string | null;
  kind: "items" | "file" | "markdown";
  entries?: SessionPlanEntryView[];
  uri?: string;
  content?: string;
  updatedAt: string;
}

export interface SessionView {
  id: string;
  name: string | null;
  /** Who requested the spawn: "operator" or a session id. Provenance only. */
  createdBy: string | null;
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
  /**
   * True only when there is no active turn and no queued prompt. This is the
   * completion signal; `status: "idle"` alone can still have queued work.
   */
  settled: boolean;
  lastSeq: number;
  /** The most recent event, projected for fleet views and dashboards. */
  lastEvent: {
    type: EventType;
    title: string | null;
    at: string;
  } | null;
  /** Provider permission requests awaiting an operator answer, FIFO (3.0). */
  pendingPermissions: PermissionView[];
  /** A provider question awaiting an operator answer (2.6). */
  pendingElicitation?: ElicitationView | null;
  lastStopReason: StopReason | null;
  /**
   * The provider's durable session id, or null before the ACP session exists.
   * This is the handle a human would pass to the provider's own resume command
   * (for example `claude --resume`). Pass it to `spawn.resumeSessionId` to
   * reattach after a supervisor restart. The HLAO session id, by contrast, is
   * an alias that lives only as long as this supervisor process. (2.7)
   */
  agentSessionId: string | null;
  /**
   * The provider session this one was forked from, when `spawn.forkSessionId`
   * created it. Null for every other session. (2.7)
   */
  forkedFrom?: string | null;
  processId: number | null;
  exit: { code: number | null; signal: string | null } | null;
  modes: SessionModes | null;
  configOptions: SessionConfigOptionView[] | null;
  /**
   * A short preview of the first prompt, for display when neither an operator
   * name nor a provider title exists. Never an addressable name. (2.8)
   */
  firstPrompt?: string | null;
  /** Latest provider usage snapshot, or null when the adapter reported none. */
  usage: SessionUsageView | null;
  /** Latest provider compaction, or null when none was reported (2.5). */
  compaction?: SessionCompactionView | null;
  /** Latest provider plan, or null when none is current (2.5). */
  plan?: SessionPlanView | null;
  /** Provider session title from ACP `session_info_update` (2.5). */
  title?: string | null;
  /** Provider agent identity from ACP initialize (2.5). */
  agentName?: string | null;
  agentVersion?: string | null;
  /**
   * True when the adapter advertises mid-turn steering
   * (`_session/steering`). A send with `steer: true` is only injected when
   * this is true; otherwise it queues. (2.9)
   */
  steeringSupported?: boolean;
}

export interface EventView {
  seq: number;
  at: string;
  type: EventType;
  turn: number | null;
  data: Record<string, unknown>;
  /**
   * True when the event was reconstructed by ACP `session/load` rather than
   * observed live. Consumers should not count replayed history as new activity.
   * (2.7)
   */
  replay?: true;
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
  /** The operator's per-backend spawn mode, when configured (3.0). */
  defaultMode?: string;
}

/** A configured adapter, as exposed by `backends.list`. */
export type BackendView = AgentView;

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

/**
 * A server-initiated frame on a persistent connection. Responses carry no
 * `type`; this discriminator is how a persistent client tells them apart.
 */
export type NotificationFrame =
  | {
      type: "notification";
      subscription: number;
      kind: "session";
      session: SessionView;
    }
  | {
      type: "notification";
      subscription: number;
      kind: "session.removed";
      sessionId: string;
    }
  | {
      type: "notification";
      subscription: number;
      kind: "event";
      sessionId: string;
      events: EventView[];
      /** The last delivered seq; pass it as `since` to resume. */
      cursor: number;
      truncated: boolean;
    };

const METHODS = [
  "hello",
  "backends.list",
  "backends.sessions",
  "sessions.spawn",
  "sessions.list",
  "sessions.get",
  "sessions.send",
  "sessions.read",
  "sessions.wait",
  "sessions.cancel",
  "sessions.close",
  "sessions.permit",
  "sessions.respond_elicitation",
  "sessions.set_mode",
  "sessions.set_config_option",
  "sessions.queue",
  "sessions.queue_drop",
  "sessions.rename",
  "sessions.forget",
  "stream.subscribe",
  "stream.unsubscribe",
  "supervisor.reload",
  "supervisor.shutdown",
] as const;

export type Method = (typeof METHODS)[number];

export interface HelloParams {
  /** The client's wire version. A major mismatch is `version_mismatch`. */
  protocolVersion?: ProtocolVersion;
  /**
   * Ask for a persistent, multiplexed connection. A supervisor without the
   * `stream.persistent` capability rejects the unknown field; call `hello`
   * without it first when the supervisor may be older.
   */
  stream?: {
    persistent?: boolean;
  };
}
export interface HelloResult {
  protocolVersion: ProtocolVersion;
  capabilities: ProtocolCapability[];
  pid: number;
  startedAt: string;
  version: string;
  sessions: number;
  configHash: string;
  configError?: string;
  /** Present when a stale lock showed the previous supervisor did not stop. */
  lastCrash?: LastCrash;
  /** Present when persistence was requested; `persistent` is the accepted value. */
  stream?: { persistent: boolean };
}
/** A supervisor that acquired the lock after its predecessor died. */
export interface LastCrash {
  pid: number;
  version: string;
  startedAt: string;
  detectedAt: string;
}
export interface SubscribeParams {
  /** Sessions to stream events for, and to report views for. 1..100 ids. */
  sessionIds?: string[];
  /** Report views for every session in the instance, including new ones. */
  fleet?: boolean;
  /** Per-session resume cursor: the last seq the client already has. */
  since?: Record<string, number>;
}
export interface SubscribeResult {
  subscription: number;
  /** Current views for the subscription's view scope. */
  sessions: SessionView[];
  /** Per-session last delivered seq; pass as `since` on resume. */
  cursors: Record<string, number>;
  /** Session ids whose history was evicted before the supplied cursor. */
  truncated: string[];
}
export interface UnsubscribeParams {
  subscription: number;
}
export interface UnsubscribeResult {
  subscription: number;
  removed: true;
}
export interface BackendsListParams {
  /** Defaults to the caller's cwd, or the supervisor's cwd for an operator. */
  cwd?: string;
}
export interface BackendsListResult {
  backends: BackendView[];
}
/**
 * A read of the provider's own session catalog (ACP `session/list`). This is
 * not an HLAO session index: the provider owns the rows, and HLAO only joins
 * the live table to mark rows it currently drives. (3.1)
 */
export interface ProviderSessionsParams {
  backend: string;
  /** Absolute cwd filter. Omit to list the provider's catalog across cwds. */
  cwd?: string;
  /** Opaque cursor from an earlier `nextCursor`. */
  cursor?: string;
}
/** One provider-owned session row, with its live HLAO attachment when present. */
export interface ProviderSessionView {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  /** True when a non-terminal HLAO session currently holds this provider id. */
  attached: boolean;
  hlaoSessionId: string | null;
  hlaoName: string | null;
  hlaoStatus: SessionStatus | null;
  /** The adapter advertises ACP `loadSession` (resume/adopt is possible). */
  loadable: boolean;
  /** The adapter advertises ACP `session/fork` (copying is possible). */
  forkable: boolean;
}
export interface ProviderSessionsResult {
  backend: string;
  /** The cwd filter used, or null when the catalog was read across cwds. */
  cwd: string | null;
  agentName: string | null;
  agentVersion: string | null;
  sessions: ProviderSessionView[];
  nextCursor: string | null;
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
  env?: Record<string, string>;
  /** Include the HLAO skill pointer in the first prompt. Default true. */
  skill?: boolean;
  /** Dedupe key for a retrying spawn (1h in the supervisor). */
  idempotencyKey?: string;
  /**
   * A provider session id from an earlier spawn. When set, the session is
   * reopened with ACP `session/load` instead of created with `session/new`;
   * the provider replays its durable history into the new event log. If a
   * live session already holds this provider id, that session is returned.
   * (2.7)
   */
  resumeSessionId?: string;
  /**
   * A provider session id to fork with ACP `session/fork`. A new provider
   * session is created from a copy of that conversation, and its history is
   * replayed through `session/load` when the backend supports it. Unlike
   * `resumeSessionId`, the source session is never modified. (2.7)
   */
  forkSessionId?: string;
}
export interface FirstTurnResult {
  stopReason?: StopReason;
  text: string;
  timedOut: boolean;
}
export interface SpawnResult {
  session: SessionView;
  /**
   * The cursor to pass as `since` to read from the session's beginning; always
   * 0. This is not read's `nextSeq` page cursor (the name predates that
   * distinction and is preserved for wire compatibility).
   */
  nextSeq: number;
  firstTurn?: FirstTurnResult;
  /** The first prompt's message id, when a prompt was sent. */
  messageId?: string;
  /** True when the idempotency key matched an existing session. */
  duplicate?: boolean;
  /** True when this spawn reopened a provider session with `session/load`. (2.7) */
  resumed?: boolean;
  /** True when this spawn created a provider session with `session/fork`. (2.7) */
  forked?: boolean;
  createdBy?: string;
}
export interface ListParams {
  includeClosed?: boolean;
  cwd?: string;
}
export interface ListResult {
  sessions: SessionView[];
}
export interface GetParams {
  sessionId: string;
}
export interface GetResult {
  session: SessionView;
}
export type SendOutcome = "completed" | "cancelled" | "timed_out";

export interface SendParams {
  sessionId: string;
  text: string;
  wait?: boolean;
  timeoutMs?: number;
  /** Caller-chosen message id; generated when omitted. */
  messageId?: string;
  /** Dedupe key for a retrying caller (1h / 256 keys in the live session). */
  idempotencyKey?: string;
  /**
   * Ask the supervisor to inject this prompt into the target's running turn
   * instead of queueing it. Injection happens only when the target is busy and
   * its adapter advertises steering; otherwise the prompt queues, which is the
   * default when this is absent or false. (2.9)
   */
  steer?: boolean;
}
export interface SendResult {
  session: SessionView;
  messageId: string;
  /** True when this call placed the message behind a running turn. */
  queued: boolean;
  /** True when the message was injected into the target's running turn. (2.9) */
  steered?: boolean;
  /** On a duplicate: true when the original message is still active or queued. */
  pending?: boolean;
  turn: number | null;
  completed: boolean;
  timedOut: boolean;
  stopReason?: StopReason;
  text?: string;
  outcome?: SendOutcome;
  /** True when the idempotency key matched an existing message. */
  duplicate?: boolean;
}
export interface ReadParams {
  sessionId: string;
  /** Forward cursor: return events with seq > since. */
  since?: number;
  /** Backward cursor: return events with seq < before. Exclusive with since. */
  before?: number;
  limit?: number;
  raw?: boolean;
  /** Keep only these event types (AND with the other filters). */
  types?: EventType[];
  /** Keep only events from this turn. */
  turn?: number;
  /** Case-insensitive literal over the event type and its data JSON. */
  grep?: string;
  /** Keep events at or after this ISO timestamp. (2.8) */
  afterAt?: string;
  /** Keep events strictly before this ISO timestamp. (2.8) */
  beforeAt?: string;
  /** Interpret `grep` as a case-insensitive regular expression. (2.8) */
  regex?: boolean;
  /**
   * Include up to this many retained neighbors around each match. `limit`
   * bounds matches, not the returned event count. Context is display-oriented:
   * paging cursors still advance by matches, so a context event may repeat.
   * (2.8)
   */
  context?: number;
}
export interface ReadResult {
  session: SessionView;
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  /** Forward cursor for the next page; always present. */
  nextSeq: number;
  /** Backward cursor for the next older page, or null when there is none. */
  nextBefore: number | null;
  hasMore: boolean;
  truncated: boolean;
  /**
   * Present when `context` was requested: the seqs that matched the filters.
   * Every other returned event is a context neighbor. (2.8)
   */
  matchedSeqs?: number[];
}
export interface WaitParams {
  /** Exactly one of sessionId or sessionIds. */
  sessionId?: string;
  sessionIds?: string[];
  /** For multiple ids: resolve on the first (`any`) or when all satisfy (`all`). */
  mode?: "any" | "all";
  until: WaitUntil;
  /** Only valid with a single id and `until: "change"`. */
  since?: number;
  /** Only valid with `until: "change"`; filters the event that satisfies it. */
  types?: EventType[];
  /** Only valid with `until: "change"`; case-insensitive literal over type + data. */
  grep?: string;
  timeoutMs?: number;
}
export interface WaitTargetResult {
  session: SessionView;
  satisfied: boolean;
  /** `pending` means the target was still waiting when the aggregate resolved. */
  reason: WaitUntil | "timeout" | "pending";
}
export interface WaitResult {
  satisfied: boolean;
  /**
   * The matched condition. `settled` is reported only as a multi-id `all`
   * aggregate, where targets may have matched different conditions; per-target
   * reasons name the actual one.
   */
  reason: WaitUntil | "timeout";
  waitedMs: number;
  results: WaitTargetResult[];
  /** Present for a single-id request; omitted when several ids were given. */
  session?: SessionView;
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
  optionId: string;
  /** Required when more than one request is pending. */
  requestId?: string;
}
export interface PermitResult {
  session: SessionView;
  requestId: string;
  optionId: string;
  by: string;
}
export interface RespondElicitationParams {
  sessionId: string;
  requestId?: string;
  action: "accept" | "decline" | "cancel";
  /** Present with `accept`; values must match the requested form schema. */
  content?: Record<string, string | number | boolean | string[]>;
}
export interface RespondElicitationResult {
  session: SessionView;
  requestId: string;
  action: "accept" | "decline" | "cancel";
  by: string;
}
export interface QueueItemView {
  /** Stable message id; the active turn's id is also in its prompt.sent event. */
  id: string;
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
  /** Exactly one of position or messageId. */
  position?: number;
  messageId?: string;
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
export interface ForgetParams {
  sessionId: string;
}
export interface ForgetResult {
  sessionId: string;
  forgotten: true;
}
export interface ShutdownParams {
  force?: boolean;
}
export interface ShutdownResult {
  sessionsClosed: number;
  /** Retained terminal sessions whose event logs are lost with the supervisor. */
  retainedDiscarded: number;
}
export interface ReloadParams {}
export interface ReloadResult {
  configHash: string;
  configError: string | null;
}

export type ParamsByMethod = {
  hello: HelloParams;
  "backends.list": BackendsListParams;
  "backends.sessions": ProviderSessionsParams;
  "sessions.spawn": SpawnParams;
  "sessions.list": ListParams;
  "sessions.get": GetParams;
  "sessions.send": SendParams;
  "sessions.read": ReadParams;
  "sessions.wait": WaitParams;
  "sessions.cancel": CancelParams;
  "sessions.close": CloseParams;
  "sessions.permit": PermitParams;
  "sessions.respond_elicitation": RespondElicitationParams;
  "sessions.set_mode": SetModeParams;
  "sessions.set_config_option": SetConfigOptionParams;
  "sessions.queue": QueueParams;
  "sessions.queue_drop": QueueDropParams;
  "sessions.rename": RenameParams;
  "sessions.forget": ForgetParams;
  "stream.subscribe": SubscribeParams;
  "stream.unsubscribe": UnsubscribeParams;
  "supervisor.reload": ReloadParams;
  "supervisor.shutdown": ShutdownParams;
};

export function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
}
