import { isTerminalStatus } from "../../protocol.js";
import type {
  ElicitationView,
  PermissionView,
  ReadResult,
  SessionView,
} from "../../protocol.js";
import { renderEvents, type RenderOptions } from "./events.js";
import {
  agentLabel,
  compactionLabel,
  pendingInputLabel,
  planLabel,
} from "./session-fields.js";
import type { Style } from "./style.js";
import { styleStatus } from "./style.js";
import { formatAge, formatTokens, oneLine } from "./text.js";

export function renderSessionHeader(session: SessionView, style: Style): string {
  const terminal = isTerminalStatus(session.status);
  const parts = [
    style.bold(session.id),
    session.name
      ? style.cyan(oneLine(session.name))
      : session.title
        ? style.dim(oneLine(session.title))
        : session.firstPrompt
          ? style.dim(oneLine(session.firstPrompt))
          : null,
    session.backend,
    styleStatus(session.status, style),
  ].filter((part): part is string => part !== null);
  const details = [
    `cwd ${oneLine(session.cwd)}`,
    `turn ${session.turn}`,
    `seq ${session.lastSeq}`,
    session.queued > 0 ? `queued ${session.queued}` : null,
    session.modes ? `mode ${session.modes.currentModeId}` : null,
    session.createdBy ? `by ${oneLine(session.createdBy)}` : null,
    session.parentId ? `parent ${session.parentId}` : "root",
    session.depth > 0 ? `root ${session.rootId}` : null,
    terminal ? `ended ${session.endedAt ? formatAge(session.endedAt) : "?"}` : null,
    terminal
      ? session.exit
        ? session.exit.signal
          ? `signal ${session.exit.signal}`
          : `exit ${session.exit.code ?? "?"}`
        : "exit unknown"
      : session.processId
        ? `pid ${session.processId}`
        : null,
  ].filter((part): part is string => part !== null);
  return `${parts.join("  ")}\n${style.dim(details.join(" · "))}`;
}

/**
 * `get`'s human projection: the state the command promises without reading
 * events. The one-line header remains available as `get --brief`.
 */
export function renderSessionState(
  session: SessionView,
  style: Style,
  commandPrefix = "hlao",
): string {
  const terminal = isTerminalStatus(session.status);
  const head = [
    style.bold(session.id),
    session.name
      ? style.cyan(oneLine(session.name))
      : session.title
        ? style.dim(oneLine(session.title))
        : session.firstPrompt
          ? style.dim(oneLine(session.firstPrompt))
          : null,
    session.backend,
    styleStatus(session.status, style),
  ]
    .filter((part): part is string => part !== null)
    .join("  ");

  const state = [
    session.settled ? "settled" : "not settled",
    `turn ${session.turn}`,
    `queued ${session.queued}`,
    session.lastStopReason ? `last stop ${session.lastStopReason}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const mode = session.modes
    ? `${session.modes.currentModeId} (${session.modes.availableModes.length} available)`
    : "—";
  const config = session.configOptions?.length
    ? session.configOptions
        .map((option) => `${option.id}=${String(option.currentValue)}`)
        .join(" · ")
    : "—";
  const usage = session.usage
    ? `${formatTokens(session.usage.used)}/${formatTokens(session.usage.size)} tokens` +
      (session.usage.cost
        ? ` · ${(session.usage.cost.amount / 100).toFixed(2)} ${session.usage.cost.currency}`
        : "") +
      ` (${formatAge(session.usage.at)})`
    : "—";
  const lineage = [
    `created by ${session.createdBy ? oneLine(session.createdBy) : "unknown"}`,
    session.parentId ? `parent ${session.parentId}` : "root",
    `root ${session.rootId}`,
    `depth ${session.depth}`,
  ].join(" · ");
  const pending = pendingInputLabel(session, commandPrefix);
  const exit = terminal
    ? session.exit
      ? session.exit.signal
        ? `signal ${session.exit.signal}`
        : `code ${session.exit.code ?? "?"}`
      : "unknown"
    : session.processId
      ? `pid ${session.processId}`
      : "—";

  return [
    head,
    style.dim(`state    ${state}`),
    style.dim(`title    ${session.title ? oneLine(session.title) : "—"}`),
    style.dim(`agent    ${agentLabel(session)}`),
    style.dim(`plan     ${planLabel(session)}`),
    style.dim(`compaction ${compactionLabel(session)}`),
    style.dim(`mode     ${mode}`),
    style.dim(`config   ${config}`),
    style.dim(`usage    ${usage}`),
    style.dim(`lineage  ${lineage}`),
    ...(session.forkedFrom
      ? [style.dim(`forked   ${oneLine(session.forkedFrom)}`)]
      : []),
    style.dim(
      `provider ${session.agentSessionId ? oneLine(session.agentSessionId) : "—"}` +
        (session.agentSessionId
          ? ` · resume with: ${commandPrefix} spawn ${session.backend} --resume ${session.agentSessionId} --cwd ${oneLine(session.cwd)}`
          : ""),
    ),
    style.dim(`pending  ${pending}`),
    style.dim(
      `exit     ${exit}${session.endedAt ? ` · ended ${formatAge(session.endedAt)}` : ""}`,
    ),
    style.dim(`cwd      ${oneLine(session.cwd)}`),
  ].join("\n");
}

export function renderReadResult(
  result: ReadResult,
  style: Style,
  commandPrefix = "hlao",
  options: RenderOptions = {},
): string {
  const lines: string[] = [renderSessionHeader(result.session, style)];
  const permissions = result.session.pendingPermissions;
  const question = result.session.pendingElicitation;

  for (const pending of permissions) {
    const hasRequest = result.events.some(
      (event) =>
        event.type === "permission.requested" &&
        event.data.requestId === pending.requestId,
    );
    lines.push("");
    if (hasRequest) {
      lines.push(
        style.dim(
          `pending permission: ${oneLine(pending.title)} — ${commandPrefix} permit ${result.session.id} --request ${oneLine(pending.requestId)} --allow`,
        ),
      );
    } else {
      lines.push(
        renderPermission(
          result.session.id,
          pending,
          style,
          commandPrefix,
          permissions.length > 1,
        ),
      );
    }
  }

  if (question) {
    const hasRequest = result.events.some(
      (event) =>
        event.type === "elicitation.requested" &&
        event.data.requestId === question.requestId,
    );
    lines.push("");
    if (hasRequest) {
      lines.push(
        style.dim(
          `pending question: ${oneLine(question.message)} — ${commandPrefix} elicit ${result.session.id}`,
        ),
      );
    } else {
      lines.push(
        renderElicitation(
          result.session.id,
          question,
          style,
          commandPrefix,
        ),
      );
    }
  }

  if (result.events.length === 0) {
    lines.push("");
    lines.push(
      style.dim(
        options.filtered
          ? `no matching events (last seq ${result.lastSeq})`
          : `no events (last seq ${result.lastSeq})`,
      ),
    );
  } else {
    lines.push("");
    lines.push(
      ...renderEvents(result.events, style, result.session.id, commandPrefix, options),
    );
  }

  if (result.truncated) {
    lines.push("");
    lines.push(
      style.yellow(
        `history starts at #${result.earliestRetainedSeq} — ${result.earliestRetainedSeq - 1} earlier events were evicted`,
      ),
    );
  }
  if (result.nextBefore !== null) {
    lines.push("");
    lines.push(
      style.dim(
        `older: ${commandPrefix} read ${result.session.id} --before ${result.nextBefore}`,
      ),
    );
  }
  if (result.hasMore) {
    lines.push("");
    lines.push(
      style.dim(
        `next: ${commandPrefix} read ${result.session.id} --since ${result.nextSeq}`,
      ),
    );
  }
  return lines.join("\n");
}

export function renderPermission(
  sessionId: string,
  permission: PermissionView,
  style: Style,
  commandPrefix = "hlao",
  multiple = false,
): string {
  const request =
    ` --request ${oneLine(permission.requestId)}`;
  const lines = [
    `${style.magenta("permission needed")} › ${oneLine(permission.title || "(untitled tool call)")}` +
      (multiple
        ? style.dim(` · ${oneLine(permission.requestId)}`)
        : ""),
  ];
  for (const option of permission.options) {
    lines.push(`  ${style.dim(option.kind.padEnd(12))} ${oneLine(option.name)} ${style.dim(`(${oneLine(option.optionId)})`)}`);
  }
  const allowed = permission.options.find(
    (option) => option.kind === "allow_once" || option.kind === "allow_always",
  );
  if (allowed) {
    lines.push(
      `  ${style.dim(`allow: ${commandPrefix} permit ${sessionId}${request} --allow`)}`,
    );
  }
  if (permission.options.some((option) => option.kind === "allow_always")) {
    lines.push(
      `  ${style.dim(`always: ${commandPrefix} permit ${sessionId}${request} --allow --always`)}`,
    );
  }
  if (permission.options.some((option) => option.kind === "reject_always")) {
    lines.push(
      `  ${style.dim(`deny always: ${commandPrefix} permit ${sessionId}${request} --deny --always`)}`,
    );
  }
  return lines.join("\n");
}

export function renderElicitation(
  sessionId: string,
  elicitation: ElicitationView,
  style: Style,
  commandPrefix = "hlao",
): string {
  const lines = [
    `${style.magenta("question")} › ${oneLine(elicitation.message || "(no message)")}`,
    style.dim(
      `request ${elicitation.requestId} · mode ${elicitation.mode}` +
        (elicitation.toolCallId ? ` · tool ${elicitation.toolCallId}` : "") +
        ` · requested ${elicitation.requestedAt}`,
    ),
  ];
  if (elicitation.mode === "url") {
    lines.push(`  ${style.dim("url:")} ${oneLine(elicitation.url ?? "—")}`);
  }
  const schema = elicitation.requestedSchema as
    | {
        properties?: Record<string, ElicitationSchemaProperty>;
        required?: string[];
      }
    | undefined;
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  for (const [key, property] of Object.entries(properties)) {
    const kind = typeof property.type === "string" ? property.type : "string";
    const flags = required.has(key) ? `${kind}, required` : kind;
    lines.push(
      `  ${style.dim(flags.padEnd(16))} ${oneLine(key)}` +
        (property.title ? `: ${oneLine(property.title)}` : ""),
    );
    if (property.description) {
      lines.push(`    ${style.dim(oneLine(property.description))}`);
    }
    const options = elicitationOptions(property);
    if (options.length > 0) {
      lines.push(`    ${style.dim(`options: ${options.join(" | ")}`)}`);
    }
  }
  if (Object.keys(properties).length === 0 && elicitation.mode === "form") {
    lines.push(style.dim("  (no form fields)"));
  }
  lines.push(
    `  ${style.dim(`accept: ${commandPrefix} elicit ${sessionId} --accept key=value ...`)}`,
  );
  lines.push(
    `  ${style.dim(
      `decline: ${commandPrefix} elicit ${sessionId} --decline · ` +
        `cancel: ${commandPrefix} elicit ${sessionId} --cancel`,
    )}`,
  );
  return lines.join("\n");
}

interface ElicitationSchemaProperty {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  enum?: unknown[];
  oneOf?: { const?: unknown }[];
  anyOf?: { const?: unknown }[];
  items?: { enum?: unknown[] };
}

function elicitationOptions(property: ElicitationSchemaProperty): string[] {
  const values: unknown[] = [];
  if (Array.isArray(property.enum)) values.push(...property.enum);
  for (const branch of property.oneOf ?? []) {
    if (branch.const !== undefined) values.push(branch.const);
  }
  for (const branch of property.anyOf ?? []) {
    if (branch.const !== undefined) values.push(branch.const);
  }
  if (Array.isArray(property.items?.enum)) values.push(...property.items.enum);
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string"),
    ),
  ];
}
