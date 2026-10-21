import type { WaitResult } from "../../protocol.js";
import {
  exitDetail,
  out,
  sessionLabel,
  type CommandContext,
} from "../context.js";
import {
  renderElicitation,
  renderPermission,
  sanitize,
  styleStatus,
} from "../render.js";

/** Human rendering for a multi-session wait. */
export function renderMultiWait(
  ctx: CommandContext,
  result: WaitResult,
  until: string,
  waited: string,
  all: boolean,
): void {
  const satisfied = result.results.filter((entry) => entry.satisfied).length;
  for (const entry of result.results) {
    const entryLabel = sessionLabel(ctx, entry.session);
    if (entry.satisfied) {
      const reason =
        (until === "settled" || until === "idle") &&
        entry.reason === "permission"
          ? "settled (permission)"
          : until === "settled" && entry.reason === "exit"
            ? "settled (exit)"
            : entry.reason;
      const detail =
        entry.reason === "exit"
          ? exitDetail(entry.session)
          : entry.reason === "permission" &&
              entry.session.pendingPermissions.length > 0
            ? entry.session.pendingPermissions
                .map((permission) => permission.title)
                .join("; ")
            : entry.reason === "permission" && entry.session.pendingElicitation
              ? entry.session.pendingElicitation.message
              : null;
      out(
        `${entryLabel}: ${reason}` + (detail ? ctx.style.dim(` · ${sanitize(detail)}`) : ""),
      );
      if (
        entry.reason === "permission" &&
        entry.session.pendingPermissions.length > 0
      ) {
        for (const permission of entry.session.pendingPermissions) {
          out(
            renderPermission(
              entry.session.id,
              permission,
              ctx.style,
              "hlao",
              entry.session.pendingPermissions.length > 1,
            ),
          );
        }
      }
      if (entry.reason === "permission" && entry.session.pendingElicitation) {
        out(
          renderElicitation(
            entry.session.id,
            entry.session.pendingElicitation,
            ctx.style,
          ),
        );
      }
    } else if (entry.reason === "pending") {
      out(`${entryLabel}: still ${styleStatus(entry.session.status, ctx.style)}`);
    } else if (entry.reason === "timeout") {
      out(
        `${entryLabel}: did not reach "${until}" ` +
          `(${styleStatus(entry.session.status, ctx.style)})`,
      );
    } else {
      out(
        `${entryLabel}: ended before reaching "${until}" ` +
          `(${styleStatus(entry.session.status, ctx.style)})`,
      );
    }
  }
  out(
    ctx.style.dim(
      `${all ? "all" : "any"}: ${satisfied}/${result.results.length} satisfied (waited ${waited})`,
    ),
  );
}

/** Human rendering for a single-session wait. */
export function renderSingleWait(
  ctx: CommandContext,
  result: WaitResult,
  entry: WaitResult["results"][number],
  until: string,
  waited: string,
  code: number,
): number {
  const label = sessionLabel(ctx, entry.session);
  switch (result.reason) {
    case "idle":
      out(`${label} is idle (waited ${waited})`);
      return code;
    case "permission":
      if (entry.session.pendingElicitation) {
        if (until === "permission") {
          out(`${label} needs input (waited ${waited})`);
        } else {
          out(`${label} settled (question) · waited ${waited}`);
        }
        out(
          renderElicitation(
            entry.session.id,
            entry.session.pendingElicitation,
            ctx.style,
          ),
        );
        return code;
      }
      const permissions = entry.session.pendingPermissions;
      if (until === "permission") {
        out(
          `${label} needs permission${
            permissions.length > 1 ? ` (${permissions.length} pending)` : ""
          } (waited ${waited})`,
        );
      } else {
        out(`${label} settled (permission) · waited ${waited}`);
      }
      for (const permission of permissions) {
        out(
          renderPermission(
            entry.session.id,
            permission,
            ctx.style,
            "hlao",
            permissions.length > 1,
          ),
        );
      }
      return code;
    case "exit": {
      const detail = exitDetail(entry.session);
      if (until === "exit") {
        out(
          `${label} is ${styleStatus(entry.session.status, ctx.style)} (waited ${waited})` +
            (detail ? ctx.style.dim(` · ${detail}`) : ""),
        );
        return code;
      }
      if (until === "settled") {
        out(
          `${label} settled (exit) · waited ${waited}: ` +
            `${styleStatus(entry.session.status, ctx.style)}` +
            (detail ? ctx.style.dim(` · ${detail}`) : ""),
        );
        return code;
      }
      out(
        `${label} ended before reaching "${until}" (waited ${waited}): ` +
          `${styleStatus(entry.session.status, ctx.style)}` +
          (detail ? ctx.style.dim(` · ${detail}`) : ""),
      );
      return code;
    }
    case "change":
      out(`${label} changed at seq ${entry.session.lastSeq} (waited ${waited})`);
      return code;
    case "timeout":
      out(
        `${label} did not reach "${until}" within ${waited}; it is ${styleStatus(entry.session.status, ctx.style)}`,
      );
      return code;
    default:
      out(`${entry.session.id}: ${result.reason}`);
      return code;
  }
}
