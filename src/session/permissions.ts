import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { ElicitationView, PermissionPolicy } from "../protocol.js";

export interface PendingPermission {
  requestId: string;
  requestedAt: string;
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
}

export interface PendingElicitation {
  requestId: string;
  requestedAt: string;
  request: CreateElicitationRequest;
  resolve: (response: CreateElicitationResponse) => void;
}

export type ElicitationAction = "accept" | "decline" | "cancel";
export type ElicitationContent = Record<
  string,
  string | number | boolean | string[]
>;

export function cancelledElicitation(): CreateElicitationResponse {
  return { action: "cancel" };
}

export function elicitationResponse(
  action: ElicitationAction,
  content?: ElicitationContent,
): CreateElicitationResponse {
  return action === "accept"
    ? { action: "accept", ...(content ? { content } : {}) }
    : { action };
}

export function toElicitationView(
  requestId: string,
  requestedAt: string,
  request: CreateElicitationRequest,
): ElicitationView {
  const toolCallId =
    "toolCallId" in request && typeof request.toolCallId === "string"
      ? request.toolCallId
      : null;
  const base = {
    requestId,
    toolCallId,
    message: request.message,
    requestedAt,
  };
  if (request.mode === "form") {
    return {
      ...base,
      mode: "form",
      requestedSchema: request.requestedSchema as unknown as Record<
        string,
        unknown
      >,
    };
  }
  if (request.mode === "url") {
    return {
      ...base,
      mode: "url",
      url: request.url as string,
      elicitationId: request.elicitationId as string,
    };
  }
  return { ...base, mode: request.mode };
}

export function cancelledResponse(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

export function selectedResponse(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

export function pickAllowOption(options: PermissionOption[]): PermissionOption | undefined {
  return (
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always")
  );
}

export function chooseByPolicy(
  options: PermissionOption[],
  policy: PermissionPolicy,
): PermissionOption | "cancelled" | null {
  if (policy === "ask") return null;
  if (policy === "allow") {
    return pickAllowOption(options) ?? "cancelled";
  }
  const reject =
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => option.kind === "reject_always");
  return reject ?? "cancelled";
}

