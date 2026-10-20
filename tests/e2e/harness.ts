import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidAlive, readLock } from "../../src/lock.js";
import type {
  CancelResult,
  CloseResult,
  GetResult,
  ListResult,
  PermitResult,
  ReadResult,
  RespondElicitationResult,
  SendResult,
  SessionView,
  SpawnResult,
  WaitResult,
} from "../../src/protocol.js";

export const CLI_ENTRY = fileURLToPath(
  new URL("../../../dist/cli.js", import.meta.url),
);
export const FAKE_AGENT = fileURLToPath(
  new URL("../fixtures/fake-acp-agent.js", import.meta.url),
);

/** The backend manifest every harness config starts with. */
export const FAKE_BACKEND = {
  command: process.execPath,
  args: [FAKE_AGENT],
  description: "scripted ACP test agent",
};

/**
 * Poll supervisor state that the test process cannot await directly. Throws a
 * labelled error when the deadline passes, so a broken precondition fails the
 * test instead of falling through.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`${label} did not happen within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
    this.writeConfig({ backends: { fake: FAKE_BACKEND } });
  }

  /** Replace this harness's user config. */
  writeConfig(value: unknown): void {
    writeFileSync(
      join(this.home, "config.json"),
      JSON.stringify(value, null, 2),
    );
  }

  /** Read, mutate, and rewrite this harness's user config. */
  updateConfig(mutate: (config: Record<string, unknown>) => void): void {
    const file = join(this.home, "config.json");
    const config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    mutate(config);
    this.writeConfig(config);
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

  /** Poll `read` until the session reports `status`. */
  async waitForSession(id: string, status: SessionValue["status"]): Promise<void> {
    await waitFor(
      async () =>
        (await this.json<ReadValue>(["read", id])).value.session.status ===
        status,
      `session ${id} reaching ${status}`,
    );
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

/** The `doctor` JSON result, shared by the tests that assert on checks. */
export interface DoctorValue {
  ok: boolean;
  checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[];
}

/** Count non-overlapping occurrences of a literal. */
export function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/*
 * Value types mirror the wire results. They are aliases, not copies, so the
 * suite cannot drift from `src/protocol.ts`.
 */
export type SessionValue = SessionView;
export type SpawnValue = SpawnResult;
export type ListValue = ListResult;
export type ReadValue = ReadResult;
export type SendValue = SendResult;
/** A single-target wait always includes the session; the wire marks it optional. */
export type WaitValue = WaitResult & { session: SessionView };
export type CloseValue = CloseResult;
export type PermitValue = PermitResult;
export type ElicitValue = RespondElicitationResult;
export type CancelValue = CancelResult;
export type GetValue = GetResult;
