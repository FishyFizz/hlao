import { fileURLToPath } from "node:url";
import { connectSupervisor, type SupervisorConnection } from "../client.js";
import { HlaoError } from "../errors.js";
import { resolveHome } from "../paths.js";
import type { SessionView } from "../protocol.js";
import {
  booleanOption,
  stringOption,
  usageError,
  type OptionSpec,
  type ParsedArgs,
} from "./args.js";
import {
  colorsEnabled,
  createStyle,
  sanitize,
  type Style,
} from "./render.js";

export const CLI_ENTRY = fileURLToPath(new URL("../cli.js", import.meta.url));

export const COMMON: OptionSpec[] = [
  { name: "json", type: "boolean" },
  { name: "home", type: "path", valueName: "DIR" },
  { name: "help", short: "h", type: "boolean" },
  { name: "no-color", type: "boolean" },
];

export interface CommandContext {
  home: string;
  callerSessionId: string | null;
  cliPath: string;
  json: boolean;
  style: Style;
}

export function contextFrom(parsed: ParsedArgs): CommandContext {
  const json = booleanOption(parsed, "json") ?? false;
  const noColor = booleanOption(parsed, "no-color") ?? false;
  return {
    home: resolveHome(stringOption(parsed, "home"), process.env),
    callerSessionId: process.env.HLAO_SESSION_ID?.trim() || null,
    cliPath: CLI_ENTRY,
    json,
    style: createStyle(colorsEnabled(json) && !noColor),
  };
}

/**
 * Resolves the session-targeting positional.
 *
 * `selfDefault` commands (read/wait/cancel/close/permit) may omit the id inside a session.
 * `selfFlag` commands (send/mode/rename) require `--self`, because their first positional is
 * already a message, mode, or new name.
 */
export function resolveTarget(
  parsed: ParsedArgs,
  command: string,
  mode: "selfDefault" | "selfFlag",
): string {
  const selfFlag = booleanOption(parsed, "self") ?? false;
  const first = parsed.positionals[0];
  const caller = process.env.HLAO_SESSION_ID?.trim();

  if (selfFlag) {
    if (mode === "selfDefault" && first !== undefined) {
      throw usageError(`${command}: pass either a session id or --self`);
    }
    if (!caller) {
      throw usageError(`${command}: --self requires HLAO_SESSION_ID`);
    }
    return caller;
  }
  if (first !== undefined) return first;
  if (mode === "selfDefault" && caller) return caller;
  if (caller) {
    throw usageError(`${command} needs a session id; pass --self to target your own session`);
  }
  throw usageError(`${command} needs a session id`);
}

export function sessionLabel(ctx: CommandContext, session: SessionView): string {
  return session.name
    ? `${ctx.style.bold(sanitize(session.name))} ${ctx.style.dim(`(${session.id})`)}`
    : ctx.style.bold(session.id);
}

export function exitDetail(session: SessionView): string {
  if (!session.exit) return "";
  return session.exit.signal
    ? `signal ${session.exit.signal}`
    : `exit ${session.exit.code ?? "?"}`;
}

export function warnInert(condition: boolean, message: string): void {
  if (condition) process.stderr.write(`hlao: ${message}\n`);
}

const PROGRESS_DELAY_MS = 2_000;

/**
 * A long wait should not look hung. The line goes to stderr only when it is a
 * TTY, so pipes and tests never see it.
 */
export function withProgress<T>(label: string, work: Promise<T>): Promise<T> {
  if (process.stderr.isTTY !== true) return work;
  let shown = false;
  let width = 0;
  const timer = setTimeout(() => {
    shown = true;
    const text = `hlao: ${label}… (Ctrl-C stops watching; the work continues)`;
    width = text.length;
    process.stderr.write(`\r${text}`);
  }, PROGRESS_DELAY_MS);
  timer.unref?.();
  const clear = (): void => {
    clearTimeout(timer);
    if (!shown) return;
    process.stderr.write(`\r${" ".repeat(width)}\r`);
  };
  return work.then(
    (value) => {
      clear();
      return value;
    },
    (error: unknown) => {
      clear();
      throw error;
    },
  );
}

export function connect(
  ctx: CommandContext,
  autostart = true,
): Promise<SupervisorConnection> {
  return connectSupervisor({
    home: ctx.home,
    cliPath: ctx.cliPath,
    callerSessionId: ctx.callerSessionId,
    autostart,
  });
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function styleHint(ctx: CommandContext, text: string): string {
  return ctx.style.dim(`next: ${text}`);
}

export function renderError(error: HlaoError): string {
  let text = `hlao: ${error.message}\n`;
  const details =
    typeof error.details === "object" && error.details !== null
      ? (error.details as Record<string, unknown>)
      : undefined;

  if (error.code === "ambiguous_id") {
    const candidates = details?.candidates as
      | { id: string; name: string | null; status: string }[]
      | undefined;
    for (const candidate of candidates ?? []) {
      text += `  ${candidate.id}  ${candidate.status}${candidate.name ? `  ${candidate.name}` : ""}\n`;
    }
  }

  if (typeof details?.sessionId === "string") {
    text += `  session: ${details.sessionId}\n`;
    text += `  inspect: hlao read ${details.sessionId} --json\n`;
  }

  if (Array.isArray(details?.stderr)) {
    const lines = details.stderr.slice(-5).map((line) => String(line));
    if (lines.length > 0) {
      text += "  adapter stderr:\n";
      for (const line of lines) {
        text += `    ${line.length > 300 ? `${line.slice(0, 300)}…` : line}\n`;
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
        const id = String(option.optionId ?? option.id ?? option.name ?? "?");
        const label =
          option.name !== undefined
            ? String(option.name)
            : option.kind !== undefined
              ? String(option.kind)
              : option.description !== undefined
                ? String(option.description)
                : undefined;
        return label && label !== id ? `${id} (${label})` : id;
      })
      .join(", ");
    if (rendered.length > 0) text += `  options: ${rendered}\n`;
  }

  if (error.code === "not_found") {
    text += `run "hlao list" to see sessions in scope\n`;
  }

  if (error.code === "bad_request") {
    text += `run "hlao help" for usage\n`;
  }
  return text;
}

