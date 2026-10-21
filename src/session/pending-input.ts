import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { HlaoError } from "../errors.js";
import type { ElicitationView, EventType, PermissionView } from "../protocol.js";
import { nowIso } from "../time.js";
import {
  cancelledElicitation,
  cancelledResponse,
  elicitationResponse,
  selectedResponse,
  toElicitationView,
  type ElicitationAction,
  type ElicitationContent,
  type PendingElicitation,
  type PendingPermission,
} from "./permissions.js";
import { toPermissionView } from "./projection.js";

export interface PendingInputDeps {
  /** The three states in which a new request is answered `cancelled`. */
  isTerminal(): boolean;
  isClosing(): boolean;
  isCancelling(): boolean;
  /** True while a prompt turn owns the session. */
  hasActiveTurn(): boolean;
  /** Mark the session blocked on operator input (status + change). */
  block(): void;
  /** Recompute status after input was answered. */
  refreshStatus(): void;
  /** Recompute status only when it is currently `waiting_permission`. */
  refreshStatusIfWaiting(): void;
  emit(type: EventType, data: Record<string, unknown>): void;
  changed(): void;
}

/**
 * The provider-input queue: permission requests and elicitations awaiting an
 * operator answer. It owns the bounded FIFO, the one-shot permission deadline,
 * and the resolution events. It owns no policy: every request is relayed, and
 * timeout fails closed.
 */
export class PendingInputs {
  readonly #sessionId: string;
  readonly #deps: PendingInputDeps;
  readonly #permissionTimeoutMs: number;
  readonly #maxPermissions: number;
  /** FIFO of provider permission requests, keyed by ACP request id. */
  readonly #pending = new Map<string, PendingPermission>();
  #pendingElicitation: PendingElicitation | null = null;

  constructor(
    sessionId: string,
    options: { permissionTimeoutMs: number; maxPermissions: number },
    deps: PendingInputDeps,
  ) {
    this.#sessionId = sessionId;
    this.#permissionTimeoutMs = options.permissionTimeoutMs;
    this.#maxPermissions = options.maxPermissions;
    this.#deps = deps;
  }

  get awaiting(): boolean {
    return this.#pending.size > 0 || this.#pendingElicitation !== null;
  }

  permissionViews(): PermissionView[] {
    return [...this.#pending.values()].map((entry) =>
      toPermissionView(entry.requestId, entry.requestedAt, entry.request),
    );
  }

  elicitationView(): ElicitationView | null {
    const pending = this.#pendingElicitation;
    return pending
      ? toElicitationView(pending.requestId, pending.requestedAt, pending.request)
      : null;
  }

  /** A provider permission request; `signal` withdraws it when the agent does. */
  requestPermission(
    params: RequestPermissionRequest,
    requestId: string,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (
      this.#deps.isTerminal() ||
      this.#deps.isClosing() ||
      this.#deps.isCancelling()
    ) {
      return Promise.resolve(cancelledResponse());
    }
    if (signal.aborted) {
      return Promise.resolve(cancelledResponse());
    }
    const data = {
      requestId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "",
      kind: params.toolCall.kind ?? null,
      options: params.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
      // True when the request belongs to work no prompt turn owns, such as an
      // autonomous cycle. It follows the same queue and timeout rules.
      outsideTurn: !this.#deps.hasActiveTurn(),
    };

    // A request is live work even when no prompt turn owns it. Claude Code can
    // run an autonomous cycle after a turn's result (a background-task
    // notification, a peer message), and its tool calls still ask for
    // permission; answering `cancelled` there aborts the tool call without
    // ever surfacing the request.
    if (this.#pending.size >= this.#maxPermissions) {
      // Fail closed, visibly. This request is not enqueued, so it has no
      // queuePosition; the provider is told the tool call was cancelled.
      this.#deps.emit("permission.requested", data);
      this.#deps.emit("permission.resolved", {
        requestId,
        optionId: null,
        by: "system",
        reason: "queue_full",
      });
      return Promise.resolve(cancelledResponse());
    }

    return new Promise<RequestPermissionResponse>((resolve) => {
      // The provider withdraws a request it no longer needs, for example when
      // it abandons the tool call. The ACP connection aborts this signal on
      // `$/cancel_request`; clearing one entry keeps the rest answerable.
      const onWithdraw = (): void => {
        if (this.#pending.get(requestId) !== pending) return;
        this.#clearPendingOne(requestId, "withdrawn", "agent");
      };
      const settle = (response: RequestPermissionResponse): void => {
        signal.removeEventListener("abort", onWithdraw);
        resolve(response);
      };
      const pending: PendingPermission = {
        requestId,
        requestedAt: nowIso(),
        request: params,
        resolve: settle,
      };
      this.#pending.set(requestId, pending);
      signal.addEventListener("abort", onWithdraw, { once: true });
      if (signal.aborted) {
        this.#clearPendingOne(requestId, "withdrawn", "agent");
        return;
      }
      this.#deps.emit("permission.requested", {
        ...data,
        // 1-based FIFO position. The first request is position 1.
        queuePosition: this.#pending.size,
      });
      this.#armPermissionTimeout(pending);
      this.#deps.block();
    });
  }

  /** A provider question; parked until answered, declined, withdrawn, or closed. */
  requestElicitation(
    params: CreateElicitationRequest,
    requestId: string,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    if (
      this.#deps.isTerminal() ||
      this.#deps.isClosing() ||
      this.#deps.isCancelling() ||
      signal.aborted
    ) {
      return Promise.resolve(cancelledElicitation());
    }
    if (this.#pendingElicitation) {
      this.#deps.emit("error", {
        message: "a second elicitation arrived while one was pending",
        requestId,
      });
      return Promise.resolve(cancelledElicitation());
    }
    // Elicitation is user input, not a permission: the operator-only permit
    // relay never answers it, because an option kind cannot invent form
    // content. The request parks until someone responds, declines, or cancels.
    this.#deps.emit("elicitation.requested", {
      requestId,
      sessionId:
        "sessionId" in params && typeof params.sessionId === "string"
          ? params.sessionId
          : null,
      toolCallId:
        "toolCallId" in params && typeof params.toolCallId === "string"
          ? params.toolCallId
          : null,
      message: params.message,
      mode: params.mode,
      ...(params.mode === "form"
        ? { requestedSchema: params.requestedSchema }
        : {}),
      ...(params.mode === "url"
        ? { url: params.url, elicitationId: params.elicitationId }
        : {}),
      outsideTurn: !this.#deps.hasActiveTurn(),
    });

    return new Promise<CreateElicitationResponse>((resolve) => {
      // The provider can withdraw a question it no longer needs. The ACP
      // connection aborts this signal on `$/cancel_request`; clearing the
      // pending state keeps the session from parking on a dead request.
      const onWithdraw = (): void => {
        if (this.#pendingElicitation?.requestId !== requestId) return;
        this.#clearPendingElicitation("withdrawn", "agent");
      };
      const settle = (response: CreateElicitationResponse): void => {
        signal.removeEventListener("abort", onWithdraw);
        resolve(response);
      };
      this.#pendingElicitation = {
        requestId,
        requestedAt: nowIso(),
        request: params,
        resolve: settle,
      };
      signal.addEventListener("abort", onWithdraw, { once: true });
      if (signal.aborted) {
        this.#clearPendingElicitation("withdrawn", "agent");
        return;
      }
      // `waiting_permission` is HLAO's single "blocked on operator input"
      // status; `pendingElicitation` says which kind it is.
      this.#deps.block();
    });
  }

  /**
   * Answer one pending request with the provider's own option id. The option
   * must be offered; HLAO never invents a fallback. With several requests
   * pending, `requestId` is required.
   */
  permit(
    optionId: string,
    requestId?: string,
    by = "operator",
  ): { requestId: string; optionId: string } {
    if (this.#pending.size === 0) {
      throw new HlaoError(
        "no_pending_permission",
        `session ${this.#sessionId} has no pending permission`,
      );
    }
    let pending: PendingPermission;
    if (requestId !== undefined) {
      const found = this.#pending.get(requestId);
      if (!found) {
        const ids = [...this.#pending.keys()];
        throw new HlaoError(
          "no_pending_permission",
          `no pending permission with request id ${requestId}`,
          { requestIds: ids },
        );
      }
      pending = found;
    } else if (this.#pending.size > 1) {
      const ids = [...this.#pending.keys()];
      throw new HlaoError(
        "bad_request",
        `session ${this.#sessionId} has ${ids.length} pending permission requests; pass --request <id> (${ids.join(", ")}) or --all-pending`,
        { requestIds: ids },
      );
    } else {
      pending = this.#pending.values().next().value!;
    }

    const chosen = pending.request.options.find(
      (option) => option.optionId === optionId,
    );
    if (!chosen) {
      throw new HlaoError(
        "bad_option",
        `permission option "${optionId}" was not offered`,
        {
          options: pending.request.options.map((option) => ({
            optionId: option.optionId,
            name: option.name,
            kind: option.kind,
          })),
        },
      );
    }
    this.#resolvePending(pending, chosen, by);
    return { requestId: pending.requestId, optionId: chosen.optionId };
  }

  /** Answer a pending provider question. Accept carries schema-shaped content. */
  respondElicitation(
    action: ElicitationAction,
    content: ElicitationContent | undefined,
    requestId: string | undefined,
    by = "operator",
  ): { requestId: string; action: ElicitationAction } {
    const pending = this.#pendingElicitation;
    if (!pending) {
      throw new HlaoError(
        "no_pending_elicitation",
        `session ${this.#sessionId} has no pending elicitation`,
      );
    }
    if (requestId !== undefined && requestId !== pending.requestId) {
      throw new HlaoError(
        "no_pending_elicitation",
        `no pending elicitation with request id ${requestId}`,
        { requestId: pending.requestId },
      );
    }
    this.#pendingElicitation = null;
    this.#deps.refreshStatus();
    this.#deps.emit("elicitation.resolved", {
      requestId: pending.requestId,
      action,
      ...(content !== undefined ? { content } : {}),
      by,
    });
    pending.resolve(elicitationResponse(action, content));
    this.#deps.changed();
    return { requestId: pending.requestId, action };
  }

  /** Clear every pending input (cancel, close, turn end, failure). */
  clearAll(reason: string, by = "system"): void {
    if (this.#pending.size > 0) {
      for (const requestId of [...this.#pending.keys()]) {
        this.#clearPendingOne(requestId, reason, by);
      }
    }
    this.#clearPendingElicitation(reason, by);
  }

  /** Answer one parked request and wake the turn. */
  #resolvePending(
    pending: PendingPermission,
    chosen: PermissionOption,
    by: string,
    reason?: string,
  ): void {
    if (this.#pending.get(pending.requestId) !== pending) return;
    this.#pending.delete(pending.requestId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.#deps.refreshStatus();
    this.#deps.emit("permission.resolved", {
      requestId: pending.requestId,
      optionId: chosen.optionId,
      optionName: chosen.name,
      by,
      ...(reason !== undefined ? { reason } : {}),
    });
    pending.resolve(selectedResponse(chosen.optionId));
    this.#deps.changed();
  }

  /**
   * Start the one absolute deadline for a request. On expiry the request fails
   * closed: prefer `reject_once`, then `reject_always`, else cancel. An allow
   * option is never selected.
   */
  #armPermissionTimeout(pending: PendingPermission): void {
    if (this.#permissionTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      if (this.#pending.get(pending.requestId) !== pending) return;
      const reject =
        pending.request.options.find((option) => option.kind === "reject_once") ??
        pending.request.options.find((option) => option.kind === "reject_always");
      if (reject) {
        this.#resolvePending(pending, reject, "timeout", "timeout");
      } else {
        this.#clearPendingOne(pending.requestId, "timeout", "timeout");
      }
    }, this.#permissionTimeoutMs);
    timer.unref?.();
    pending.timer = timer;
  }

  #clearPendingElicitation(reason: string, by = "system"): void {
    const pending = this.#pendingElicitation;
    if (!pending) return;
    this.#pendingElicitation = null;
    this.#deps.refreshStatusIfWaiting();
    this.#deps.emit("elicitation.resolved", {
      requestId: pending.requestId,
      action: "cancel",
      by,
      reason,
    });
    pending.resolve(cancelledElicitation());
    this.#deps.changed();
  }

  /** Clear one request without touching its siblings. */
  #clearPendingOne(requestId: string, reason: string, by = "system"): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.#deps.refreshStatusIfWaiting();
    this.#deps.emit("permission.resolved", {
      requestId: pending.requestId,
      optionId: null,
      by,
      reason,
    });
    pending.resolve(cancelledResponse());
    this.#deps.changed();
  }
}
