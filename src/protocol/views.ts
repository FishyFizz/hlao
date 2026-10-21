/**
 * The values a session presents to a client: status, projected provider state,
 * and the typed event stream. These are the shapes every read returns; the
 * request/response envelopes and method names live in `methods.ts`.
 */

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
