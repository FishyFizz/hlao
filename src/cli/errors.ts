import type { HlaoError } from "../errors.js";
import { sanitize } from "./render.js";

/** The human error report; details are rendered only when they add context. */
export function renderError(error: HlaoError): string {
  let text = `hlao: ${sanitize(error.message)}\n`;
  const details =
    typeof error.details === "object" && error.details !== null
      ? (error.details as Record<string, unknown>)
      : undefined;

  if (error.code === "ambiguous_id") {
    const candidates = details?.candidates as
      | { id: string; name: string | null; status: string }[]
      | undefined;
    for (const candidate of candidates ?? []) {
      text += `  ${sanitize(candidate.id)}  ${sanitize(candidate.status)}${candidate.name ? `  ${sanitize(candidate.name)}` : ""}\n`;
    }
  }

  if (typeof details?.sessionId === "string") {
    text += `  session: ${details.sessionId}\n`;
    text += `  inspect: hlao read ${details.sessionId} --json\n`;
    text += `  recover: hlao close ${details.sessionId}\n`;
  }

  if (Array.isArray(details?.stderr)) {
    const lines = details.stderr.slice(-5).map((line) => String(line));
    if (lines.length > 0) {
      text += "  adapter stderr:\n";
      for (const line of lines) {
        const bounded = line.length > 300 ? `${line.slice(0, 300)}…` : line;
        text += `    ${sanitize(bounded)}\n`;
      }
    }
  }

  if (typeof details?.exit === "object" && details.exit !== null) {
    const exit = details.exit as { code?: unknown; signal?: unknown };
    const detail =
      typeof exit.signal === "string" && exit.signal.length > 0
        ? `signal ${exit.signal}`
        : `code ${exit.code ?? "unknown"}`;
    text += `  adapter exit: ${detail}\n`;
  }

  if (Array.isArray(details?.options)) {
    const options = details.options as {
      optionId?: unknown;
      id?: unknown;
      kind?: unknown;
      name?: unknown;
      description?: unknown;
    }[];
    const rendered = options
      .map((option) => {
        const id = sanitize(
          String(option.optionId ?? option.id ?? option.name ?? "?"),
        );
        const rawLabel =
          option.name !== undefined
            ? String(option.name)
            : option.kind !== undefined
              ? String(option.kind)
              : option.description !== undefined
                ? String(option.description)
                : undefined;
        const label = rawLabel === undefined ? undefined : sanitize(rawLabel);
        return label !== undefined && label !== id ? `${id} (${label})` : id;
      })
      .join(", ");
    if (rendered.length > 0) text += `  options: ${rendered}\n`;
  }

  if (error.code === "not_found") {
    text += `run "hlao list" to see sessions in this instance\n`;
  }

  if (error.code === "bad_request") {
    text += `run "hlao help" for usage\n`;
  }
  return text;
}
