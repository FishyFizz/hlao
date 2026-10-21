import { fileURLToPath } from "node:url";
import { resolveHome } from "../paths.js";
import type { SessionView } from "../protocol.js";
import {
  booleanOption,
  stringOption,
  usageError,
  type OptionSpec,
  type ParsedArgs,
} from "./args.js";
import { setJsonEnvelope } from "./output.js";
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

// Output and connection stay in their own modules; this barrel keeps the
// command-facing imports stable.
export {
  configureJsonEnvelope,
  out,
  setJsonEnvelope,
  writeJson,
  writeJsonFailure,
  writeJsonLine,
} from "./output.js";
export {
  connect,
  ensureCapability,
  hasCapability,
} from "./connect.js";
export { renderError } from "./errors.js";

export function contextFrom(parsed: ParsedArgs): CommandContext {
  const json = booleanOption(parsed, "json") ?? false;
  const envelope = booleanOption(parsed, "json-envelope") ?? false;
  if (envelope && !json) {
    throw usageError("--json-envelope requires --json (or use --json=envelope)");
  }
  setJsonEnvelope(envelope);
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

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/** Poll a predicate until it holds or the deadline passes. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await sleepMs(100);
  }
  return true;
}

export function styleHint(ctx: CommandContext, text: string): string {
  return ctx.style.dim(`next: ${text}`);
}
