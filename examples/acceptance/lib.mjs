import { spawn } from "node:child_process";

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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hlao ${args.join(" ")} timed out`));
    }, options.timeoutMs ?? 120_000);

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

export function lastAgentText(readResult) {
  let text = "";
  for (const event of readResult.events) {
    if (event.type === "agent.message" && typeof event.data.text === "string") {
      text += event.data.text;
    }
  }
  return text.trim();
}

export async function closeQuietly(sessionId) {
  try {
    await hlao(["close", sessionId]);
  } catch {
    // The example is already finishing; a close failure is not the headline.
  }
}
