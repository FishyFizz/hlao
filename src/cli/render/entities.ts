import type { AgentView, ProviderSessionsResult } from "../../protocol.js";
import type { Style } from "./style.js";
import { fitTable, renderTable } from "./table.js";
import {
  formatAge,
  oneLine,
  truncateMiddle,
  truncateRight,
} from "./text.js";

export function renderAgentTable(
  agents: AgentView[],
  style: Style,
  width?: number,
): string {
  if (agents.length === 0) return style.dim("no backends configured");
  let headers = ["NAME", "SOURCE", "READY", "MODE", "CONFIG", "COMMAND", "NOTES"];
  let rows = agents.map((agent) => {
    const commandLine = [agent.command, ...agent.args].join(" ");
    return [
      oneLine(agent.name),
      oneLine(agent.source),
      agent.available ? style.green("yes") : style.red("no"),
      agent.defaultMode ? oneLine(agent.defaultMode) : "—",
      agent.configPath ? truncateMiddle(oneLine(agent.configPath), 40) : "—",
      truncateMiddle(oneLine(commandLine), 60),
      agent.available
        ? oneLine(agent.description ?? "—")
        : style.red(oneLine(agent.unavailableReason ?? "unavailable")),
    ];
  });

  if (width !== undefined && width > 0) {
    const fitted = fitTable({
      columns: headers,
      rows,
      width,
      // NOTES, then CONFIG, then MODE, then COMMAND, then SOURCE.
      dropOrder: ["NOTES", "CONFIG", "MODE", "COMMAND", "SOURCE"],
      // Only the command has useful internal structure to shave; CONFIG is the
      // next-best flexible column when COMMAND is already gone.
      shrinkable: ["COMMAND", "CONFIG"],
      shrinkPriority: ["COMMAND", "CONFIG"],
    });
    headers = fitted.columns;
    rows = fitted.rows;
  }

  return renderTable(headers, rows, style);
}

export function renderProviderSessionTable(
  result: ProviderSessionsResult,
  style: Style,
  width?: number,
): string {
  const scope = result.cwd ? `cwd ${oneLine(result.cwd)}` : "all cwds";
  const heading =
    `${style.bold(result.backend)} provider sessions · ${scope}` +
    (result.agentName
      ? style.dim(
          ` · ${oneLine(result.agentName)}${result.agentVersion ? `@${oneLine(result.agentVersion)}` : ""}`,
        )
      : "");
  if (result.sessions.length === 0) {
    return `${heading}\n${style.dim("no provider sessions")}`;
  }

  let headers = ["SESSION ID", "UPDATED", "TITLE", "CWD", "HLAO"];
  let rows = result.sessions.map((row) => [
    oneLine(row.sessionId),
    row.updatedAt ? formatAge(row.updatedAt) : "—",
    row.title ? truncateRight(oneLine(row.title), 40) : "—",
    truncateMiddle(oneLine(row.cwd), 40),
    row.attached
      ? `${oneLine(row.hlaoSessionId ?? "?")}${
          row.hlaoName ? ` · ${oneLine(row.hlaoName)}` : ""
        }${row.hlaoStatus ? ` · ${row.hlaoStatus}` : ""}`
      : style.dim("provider-only"),
  ]);

  if (width !== undefined && width > 0) {
    const fitted = fitTable({
      columns: headers,
      rows,
      width,
      // Keep SESSION ID and HLAO at every width; drop the display-only columns.
      dropOrder: ["TITLE", "CWD", "UPDATED"],
      shrinkable: [],
    });
    headers = fitted.columns;
    rows = fitted.rows;
  }

  return (
    `${heading}\n${renderTable(headers, rows, style)}` +
    (result.nextCursor
      ? `\n${style.dim(`next cursor ${oneLine(result.nextCursor)}`)}`
      : "")
  );
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export function renderDoctor(checks: DoctorCheck[], style: Style): string {
  return checks
    .map((check) => {
      const mark =
        check.status === "ok"
          ? style.green("✓")
          : check.status === "warn"
            ? style.yellow("!")
            : style.red("✗");
      return `${mark} ${check.name}: ${check.detail}`;
    })
    .join("\n");
}
