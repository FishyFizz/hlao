import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Invoke the same CLI a human uses. HLAO_CLI points at the built entry point
 * during development; without it the globally installed `hlao` is used.
 */
export function hlao(args, options = {}) {
  const cli = process.env.HLAO_CLI;
  const command = cli ? process.execPath : "hlao";
  const argv = cli ? [cli, ...args, "--json"] : [...args, "--json"];
  const env = { ...process.env, ...(options.env ?? {}) };

  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs =
      options.timeoutMs ??
      Number(process.env.HLAO_EXAMPLE_TIMEOUT_MS ?? 120_000);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hlao ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      let value = null;
      try {
        value = JSON.parse(stdout);
      } catch {
        value = null;
      }
      resolve({ code, value, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function requireOk(result, label) {
  if (result.code !== 0) {
    const message =
      result.value?.error?.message ?? result.stderr.trim() ?? `exit ${result.code}`;
    throw new Error(`${label}: ${message}`);
  }
  return result.value;
}

/**
 * Parse the example's flags and choose an isolated runtime home. A direct run
 * must not mix demo sessions into the operator's real HLAO_HOME; pass --home
 * to reuse one, or set HLAO_HOME. The acceptance harness already sets it.
 */
export function configureExample(argv) {
  const parsed = parseExampleArgs(argv);
  const explicit =
    parsed.options.home !== undefined || process.env.HLAO_HOME !== undefined;
  const home =
    parsed.options.home ??
    process.env.HLAO_HOME ??
    mkdtempSync(join(tmpdir(), "hlao-example-"));
  process.env.HLAO_HOME = home;
  console.log(`HLAO_HOME ${home}${explicit ? "" : " (temporary)"}`);
  return { ...parsed, home };
}

export function parseExampleArgs(argv) {
  const options = { env: [] };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals >= 0) {
      const key = token.slice(2, equals);
      const value = token.slice(equals + 1);
      pushOption(options, key, value);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    index += 1;
    pushOption(options, key, value);
  }
  return { options, positionals };
}

function pushOption(options, key, value) {
  if (key === "env") options.env.push(value);
  else options[key] = value;
}

export function envRecord(pairs) {
  const env = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) throw new Error(`--env expects K=V, got ${pair}`);
    env[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return env;
}

export function lastAgentText(readResultOrEvents) {
  const events = Array.isArray(readResultOrEvents)
    ? readResultOrEvents
    : readResultOrEvents.events ?? [];
  let text = "";
  for (const event of events) {
    if (event.type === "agent.message" && typeof event.data.text === "string") {
      text += event.data.text;
    }
  }
  return text.trim();
}

/** The full retained transcript, not one bounded page. */
export async function readAllEvents(sessionId) {
  const result = requireOk(await hlao(["export", sessionId]), "export session");
  return result.events ?? [];
}

export function parseDurationMs(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(value).trim());
  if (match === null) throw new Error(`bad duration "${value}"`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
  return Math.round(amount * factor);
}

export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function closeQuietly(sessionId) {
  try {
    await hlao(["close", sessionId]);
  } catch {
    // The example is already finishing; a close failure is not the headline.
  }
}
