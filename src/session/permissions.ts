import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { PermissionPolicy } from "../protocol.js";

export interface PendingPermission {
  requestId: string;
  requestedAt: string;
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
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

