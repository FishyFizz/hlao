import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { logPath } from "./paths.js";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * Supervisor diagnostics. Never a source of orchestration truth; the live
 * session table is. Rotation is best-effort and happens once at startup.
 */
export class Logger {
  readonly path: string;

  constructor(home: string) {
    this.path = logPath(home);
    try {
      if (existsSync(this.path) && statSync(this.path).size > MAX_LOG_BYTES) {
        renameSync(this.path, `${this.path}.1`);
      }
    } catch {
      // Rotation is optional.
    }
  }

  info(message: string): void {
    this.#write("info", message);
  }

  warn(message: string): void {
    this.#write("warn", message);
  }

  error(message: string): void {
    this.#write("error", message);
  }

  #write(level: string, message: string): void {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`;
    try {
      appendFileSync(this.path, line);
    } catch {
      // A log failure must not take the supervisor down.
    }
    if (process.env.HLAO_DEBUG === "1") {
      process.stderr.write(line);
    }
  }
}
