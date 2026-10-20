import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { lastCrashPath } from "./paths.js";
import type { LastCrash } from "./protocol.js";

/**
 * The crash marker is diagnostic state, not orchestration state: it records the
 * lock owner that was replaced after its pid died or stopped answering.
 */
export function readCrashMarker(home: string): LastCrash | null {
  const file = lastCrashPath(home);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.version !== "string" ||
      typeof value.startedAt !== "string" ||
      typeof value.detectedAt !== "string"
    ) {
      return null;
    }
    return value as unknown as LastCrash;
  } catch {
    return null;
  }
}

export function writeCrashMarker(home: string, marker: LastCrash): void {
  const file = lastCrashPath(home);
  const temp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Already renamed or never created.
    }
  }
}

export function clearCrashMarker(home: string): void {
  try {
    unlinkSync(lastCrashPath(home));
  } catch {
    // Already gone.
  }
}
