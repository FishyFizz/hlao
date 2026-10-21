import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  SessionCompactionView,
  SessionPlanEntryView,
  SessionPlanView,
} from "../protocol.js";
import { nowIso } from "../time.js";
import { contentBlocksText, contentText } from "./projection.js";

/**
 * The provider's own session state, projected for the session view. This is
 * separate from the event log: the log records what happened, this records the
 * latest value of each provider-owned field.
 */
export interface ProviderState {
  compaction: SessionCompactionView | null;
  plan: SessionPlanView | null;
  title: string | null;
  /** Notices already emitted at each pressure threshold, so each fires once. */
  contextPressure: { warn75: boolean; warn90: boolean };
}

export function createProviderState(): ProviderState {
  return {
    compaction: null,
    plan: null,
    title: null,
    contextPressure: { warn75: false, warn90: false },
  };
}

export function applyProviderState(
  state: ProviderState,
  update: SessionUpdate,
): void {
  const at = nowIso();
  switch (update.sessionUpdate) {
    case "compaction_update": {
      const same = state.compaction?.id === update.compactionId;
      const summary =
        update.summary === undefined
          ? same
            ? state.compaction!.summary
            : null
          : update.summary === null
            ? null
            : contentBlocksText(update.summary);
      const error =
        update.error === undefined
          ? same
            ? state.compaction!.error
            : null
          : update.error;
      state.compaction = {
        id: update.compactionId,
        status: update.status,
        summary,
        error,
        updatedAt: at,
      };
      break;
    }
    case "compaction_summary_chunk": {
      const text = contentText(update.content);
      if (state.compaction?.id === update.compactionId) {
        state.compaction = {
          ...state.compaction,
          summary: `${state.compaction.summary ?? ""}${text}`,
          updatedAt: at,
        };
      } else {
        state.compaction = {
          id: update.compactionId,
          status: "in_progress",
          summary: text,
          error: null,
          updatedAt: at,
        };
      }
      break;
    }
    case "plan": {
      state.plan = {
        planId: null,
        kind: "items",
        entries: planEntries(update.entries),
        updatedAt: at,
      };
      break;
    }
    case "plan_update": {
      const plan = update.plan;
      if (plan.type === "items") {
        state.plan = {
          planId: plan.planId,
          kind: "items",
          entries: planEntries(plan.entries),
          updatedAt: at,
        };
      } else if (plan.type === "file") {
        state.plan = {
          planId: plan.planId,
          kind: "file",
          uri: plan.uri,
          updatedAt: at,
        };
      } else {
        state.plan = {
          planId: plan.planId,
          kind: "markdown",
          content: plan.content,
          updatedAt: at,
        };
      }
      break;
    }
    case "plan_removed": {
      if (
        state.plan !== null &&
        (state.plan.planId === null || state.plan.planId === update.planId)
      ) {
        state.plan = null;
      }
      break;
    }
    case "session_info_update": {
      if (update.title !== undefined) state.title = update.title;
      break;
    }
    default:
      break;
  }
}

/** Derive context-pressure notices from provider usage; no timer. */
export function checkContextPressure(
  state: ProviderState,
  used: number,
  size: number,
  emit: (data: {
    severity: "warning" | "error";
    title: string;
    description: string;
  }) => void,
): void {
  if (!(size > 0) || !Number.isFinite(used)) return;
  const ratio = used / size;
  if (ratio < 0.7) {
    state.contextPressure = { warn75: false, warn90: false };
    return;
  }
  const percent = Math.round(ratio * 100);
  if (ratio >= 0.75 && !state.contextPressure.warn75) {
    state.contextPressure.warn75 = true;
    emit({
      severity: "warning",
      title: "context pressure",
      description: `${used}/${size} tokens (${percent}%)`,
    });
  }
  if (ratio >= 0.9 && !state.contextPressure.warn90) {
    state.contextPressure.warn90 = true;
    emit({
      severity: "error",
      title: "context pressure",
      description: `${used}/${size} tokens (${percent}%)`,
    });
  }
}

/** Strip provider `_meta` and keep the plan-entry fields HLAO displays. */
function planEntries(
  entries: Array<{ content: string; priority: string; status: string }>,
): SessionPlanEntryView[] {
  return entries.map(({ content, priority, status }) => ({
    content,
    priority,
    status,
  }));
}
