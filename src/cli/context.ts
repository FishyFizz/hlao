import { fileURLToPath } from "node:url";
import { connectSupervisor, type SupervisorConnection } from "../client.js";
import { HlaoError } from "../errors.js";
import { resolveHome } from "../paths.js";
import type {
  HelloResult,
  ProtocolCapability,
  SessionView,
} from "../protocol.js";
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
  { name: "json-envelope", type: "boolean" },
  { name: "home", type: "path", valueName: "DIR" },
  { name: "help", short: "h", type: "boolean" },
  { name: "no-color", type: "boolean" },
];

export interface CommandContext {
  home: string;
  callerSessionId: string | null;
  cliPath: string;
  json: boolean;
  jsonEnvelope: boolean;
  style: Style;
}

let jsonEnvelope = false;
let jsonCommand = "hlao";

/** Records the command name for `--json=envelope`. */
export function configureJsonEnvelope(command: string): void {
  jsonCommand = command;
}

/** Set before dispatch so even errors and help/version honor the flag. */
export function setJsonEnvelope(enabled: boolean): void {
  jsonEnvelope = enabled;
}

export function contextFrom(parsed: ParsedArgs): CommandContext {
  const json = booleanOption(parsed, "json") ?? false;
  const envelope = booleanOption(parsed, "json-envelope") ?? false;
  if (envelope && !json) {
    throw usageError("--json-envelope requires --json (or use --json=envelope)");
  }
  jsonEnvelope = envelope;
  const noColor = booleanOption(parsed, "no-color") ?? false;
  return {
    home: resolveHome(stringOption(parsed, "home"), process.env),
    callerSessionId: process.env.HLAO_SESSION_ID?.trim() || null,
    cliPath: CLI_ENTRY,
    json,
    jsonEnvelope: envelope,
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

let capabilityCache: {
  endpoint: string;
  capabilities: Set<string>;
} | null = null;

/**
 * Feature-detect an additive wire capability. A new CLI may meet a supervisor
 * started before an upgrade; the protocol requires major equality, so the
 * command is refused with a clear restart hint rather than an unknown-field
 * error from an older parser.
 */
export async function ensureCapability(
  conn: SupervisorConnection,
  capability: ProtocolCapability,
  command: string,
): Promise<void> {
  if (capabilityCache === null || capabilityCache.endpoint !== conn.lock.endpoint) {
    const hello = await conn.request<HelloResult>("hello", {});
    capabilityCache = {
      endpoint: conn.lock.endpoint,
      capabilities: new Set(
        Array.isArray(hello.capabilities) ? hello.capabilities : [],
      ),
    };
  }
  if (!capabilityCache.capabilities.has(capability)) {
    throw new HlaoError(
      "version_mismatch",
      `${command} needs the "${capability}" protocol capability; the running supervisor predates it. Restart it with "hlao down" and retry.`,
    );
  }
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
  const payload = jsonEnvelope
    ? { ok: true, command: jsonCommand, result: value }
    : value;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** One JSON document per line, envelope-aware (watch/follow streams). */
export function writeJsonLine(value: unknown): void {
  const payload = jsonEnvelope
    ? { ok: true, command: jsonCommand, result: value }
    : value;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Error output for the envelope mode; the default error shape is unchanged. */
export function writeJsonFailure(error: {
  code: string;
  message: string;
  details?: unknown;
}): void {
  const payload = jsonEnvelope
    ? { ok: false, command: jsonCommand, error }
    : { ok: false, error };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function jsonEnvelopeEnabled(): boolean {
  return jsonEnvelope;
}

export function jsonCommandName(): string {
  return jsonCommand;
}

export function styleHint(ctx: CommandContext, text: string): string {
  return ctx.style.dim(`next: ${text}`);
}

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

