import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HlaoError } from "./errors.js";

/** Resolves the runtime home. `--home` wins; then HLAO_HOME; then ~/.hlao. */
export function resolveHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = explicit ?? env.HLAO_HOME;
  return resolve(chosen && chosen.trim().length > 0 ? chosen : join(homedir(), ".hlao"));
}

export function ensureHome(home: string): void {
  try {
    mkdirSync(home, { recursive: true });
  } catch (error) {
    throw new HlaoError(
      "internal",
      `cannot create HLAO home at ${home}: ${(error as Error).message}`,
    );
  }
}

export function lockPath(home: string): string {
  return join(home, "supervisor.json");
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function lastCrashPath(home: string): string {
  return join(home, "last-crash.json");
}

export function logPath(home: string): string {
  return join(home, "supervisor.log");
}

/**
 * Append-only spawn receipts. This is a historical ledger, not live state:
 * entries say which provider conversation a parent attached as a child, and
 * never claim the child is still running.
 */
export function spawnLedgerPath(home: string): string {
  return join(home, "spawn-ledger.jsonl");
}

export function projectBackendsPath(cwd: string): string {
  return join(cwd, ".hlao", "agents.json");
}

/**
 * Named pipes are namespaced per home so two HLAO_HOMEs (e.g. tests) never collide.
 * The hash keeps the pipe name short and free of path characters.
 */
export function supervisorEndpoint(home: string): string {
  if (process.platform === "win32") {
    const hash = createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\hlao-${hash}`;
  }
  return join(home, "supervisor.sock");
}

export function isWindows(): boolean {
  return process.platform === "win32";
}
