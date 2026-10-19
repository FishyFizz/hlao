import {
  appendFileSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { logPath } from "./paths.js";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * Supervisor diagnostics. Never a source of orchestration truth; the live
 * session table is. Rotation is best-effort, checked as the file grows, and
 * keeps one previous file at `<path>.1`.
 */
export class Logger {
  readonly path: string;
  #bytes = 0;

  constructor(home: string) {
    this.path = logPath(home);
    try {
      this.#bytes = existsSync(this.path) ? statSync(this.path).size : 0;
      if (this.#bytes > MAX_LOG_BYTES) this.#rotate();
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
    if (this.#bytes + Buffer.byteLength(line, "utf8") > MAX_LOG_BYTES) {
      this.#rotate();
    }
    try {
      appendFileSync(this.path, line);
      this.#bytes += Buffer.byteLength(line, "utf8");
    } catch {
      // A log failure must not take the supervisor down.
    }
    if (process.env.HLAO_DEBUG === "1") {
      process.stderr.write(line);
    }
  }

  #rotate(): void {
    try {
      if (existsSync(`${this.path}.1`)) unlinkSync(`${this.path}.1`);
      renameSync(this.path, `${this.path}.1`);
      this.#bytes = 0;
    } catch {
      // Retry on a later write; diagnostics are not worth failing over.
    }
  }
}
