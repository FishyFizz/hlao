import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidAlive, readLock } from "../../src/lock.js";

export const CLI_ENTRY = fileURLToPath(
  new URL("../../../dist/cli.js", import.meta.url),
);
export const FAKE_AGENT = fileURLToPath(
  new URL("../fixtures/fake-acp-agent.js", import.meta.url),
);

export interface RunOptions {
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  json?: boolean;
  cwd?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * One isolated runtime home per test file/test: its own supervisor, named pipe,
 * config, and fake backend. Cleanup always ends the supervisor.
 */
export class Harness {
  readonly home: string;
  readonly cliEntry: string;

  constructor() {
    this.home = mkdtempSync(join(tmpdir(), "hlao-e2e-"));
    this.cliEntry = CLI_ENTRY;
    writeFileSync(
      join(this.home, "config.json"),
      JSON.stringify(
        {
          backends: {
            fake: {
              command: process.execPath,
              args: [FAKE_AGENT],
              description: "scripted ACP test agent",
            },
          },
        },
        null,
        2,
      ),
    );
  }

  run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const json = options.json ?? true;
    const argv = [this.cliEntry, ...args, "--home", this.home];
    if (json) argv.push("--json");

    const env: NodeJS.ProcessEnv = { ...process.env, HLAO_HOME: this.home };
    for (const key of [
      "HLAO_SESSION_ID",
      "HLAO_PARENT_ID",
      "HLAO_ROOT_ID",
      "HLAO_DEPTH",
      "HLAO_BACKEND",
      "HLAO_CLI",
      "NO_COLOR",
    ]) {
      delete env[key];
    }
    env.NO_COLOR = "1";
    Object.assign(env, options.env ?? {});

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, argv, {
        cwd: options.cwd ?? process.cwd(),
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`hlao ${args.join(" ")} timed out\n${stderr}`));
      }, options.timeoutMs ?? 60_000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });

      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    });
  }

  async json<T>(
    args: string[],
    options: RunOptions = {},
  ): Promise<{ code: number | null; value: T }> {
    const result = await this.run(args, { ...options, json: true });
    let value: T;
    try {
      value = JSON.parse(result.stdout) as T;
    } catch {
      throw new Error(
        `expected JSON from hlao ${args.join(" ")}; got:\n${result.stdout}\n${result.stderr}`,
      );
    }
    return { code: result.code, value };
  }

  async cleanup(): Promise<void> {
    try {
      await this.run(["down", "--force"], { timeoutMs: 15_000 });
    } catch {
      // Fall through to the pid.
    }
    const lock = readLock(this.home);
    if (lock && pidAlive(lock.pid)) {
      try {
        process.kill(lock.pid);
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      rmSync(this.home, { recursive: true, force: true });
    } catch {
      // Windows may still hold the log for a moment.
    }
  }
}

export interface JsonError {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export interface SpawnValue {
  session: SessionValue;
  nextSeq: number;
  firstTurn?: { stopReason?: string; text: string; timedOut: boolean };
}

export interface SessionValue {
  id: string;
  name: string | null;
  backend: string;
  cwd: string;
  status: string;
  parentId: string | null;
  rootId: string;
  depth: number;
  turn: number;
  turnStartedAt: string | null;
  queued: number;
  settled: boolean;
  lastSeq: number;
  lastEvent: { type: string; title: string | null; at: string } | null;
  endedAt: string | null;
  pendingPermission: {
    requestId: string;
    title: string;
    options: { optionId: string; name: string; kind: string }[];
  } | null;
  lastStopReason: string | null;
  permissionPolicy: "ask" | "allow" | "deny";
  modes: {
    currentModeId: string;
    availableModes: { id: string; name: string; description?: string }[];
  } | null;
  configOptions: {
    id: string;
    name: string;
    category?: string;
    type: "select" | "boolean";
    currentValue: string | boolean;
    values: { value: string; name: string; group?: string }[];
  }[] | null;
  usage: {
    used: number;
    size: number;
    cost: { amount: number; currency: string } | null;
    at: string;
  } | null;
}

export interface ListValue {
  sessions: SessionValue[];
}

export interface ReadValue {
  session: SessionValue;
  events: { seq: number; type: string; data: Record<string, unknown> }[];
  earliestRetainedSeq: number;
  lastSeq: number;
  nextSeq: number;
  nextBefore: number | null;
  hasMore: boolean;
  truncated: boolean;
}

export interface SendValue {
  session: SessionValue;
  queued: boolean;
  turn: number | null;
  completed: boolean;
  timedOut: boolean;
  stopReason?: string;
  text?: string;
}

export interface WaitValue {
  satisfied: boolean;
  reason: string;
  waitedMs: number;
  results: {
    session: SessionValue;
    satisfied: boolean;
    reason: string;
  }[];
  session: SessionValue;
}

export interface CloseValue {
  session: SessionValue;
  killed: boolean;
  wasTerminal: boolean;
}

export interface PermitValue {
  session: SessionValue;
  requestId: string;
  optionId: string;
  by: string;
}

export interface CancelValue {
  session: SessionValue;
  discarded: number;
}

export interface GetValue {
  session: SessionValue;
}
