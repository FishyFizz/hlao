import type { BackendManifest } from "../config.js";
import type {
  EventType,
  EventView,
  StopReason,
  WaitUntil,
} from "../protocol.js";

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
  /** One-shot operator wait before a request fails closed; 0 parks (3.0). */
  permissionTimeoutMs: number;
  /** Bound on the pending permission FIFO, captured at spawn (3.0). */
  maxPendingPermissions: number;
  home: string;
  config: SessionConfig;
  cliPath: string;
  /** Include the skill pointer in the first prompt. Default true at the boundary. */
  skill: boolean;
  skillPath: string;
  skillVersion: string;
  /** Provider session to reopen with ACP `session/load` instead of `session/new`. */
  resumeSessionId?: string;
  /** Provider session to copy with ACP `session/fork`. */
  forkSessionId?: string;
  log: (line: string) => void;
}

export interface SendResult {
  messageId: string;
  queued: boolean;
  /** True when the prompt was injected into the running turn. */
  steered?: boolean;
  /** On a duplicate: true when the original message is still active or queued. */
  pending?: boolean;
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
  afterAt?: number;
  beforeAt?: number;
  regex?: boolean;
  context?: number;
}

export interface ReadResult {
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;
  nextBefore: number | null;
  hasMore: boolean;
  truncated: boolean;
  matchedSeqs?: number[];
}

export interface WaitResult {
  satisfied: boolean;
  reason: WaitUntil | "timeout";
  waitedMs: number;
}
