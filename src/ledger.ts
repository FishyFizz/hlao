import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { spawnLedgerPath } from "./paths.js";

/**
 * One historical receipt: this parent attached this provider conversation as a
 * child. It is written once at spawn/attach time and never updated. Recovery
 * uses the parent provider id, because the HLAO ids are lifetime-scoped.
 *
 * The ledger makes no liveness claim. The supervisor's live table remains the
 * only authority for whether a session is running.
 */
export interface SpawnReceipt {
  version: 1;
  at: string;
  parentProviderId: string;
  parentSessionId: string | null;
  childProviderId: string;
  childSessionId: string;
  backend: string;
  cwd: string;
  name: string | null;
}

export type SpawnReceiptInput = Omit<SpawnReceipt, "version" | "at"> & {
  at?: string;
};

/** Append one receipt as a single JSONL line. */
export function recordSpawnReceipt(
  home: string,
  input: SpawnReceiptInput,
): SpawnReceipt {
  const receipt: SpawnReceipt = {
    version: 1,
    at: input.at ?? new Date().toISOString(),
    parentProviderId: input.parentProviderId,
    parentSessionId: input.parentSessionId,
    childProviderId: input.childProviderId,
    childSessionId: input.childSessionId,
    backend: input.backend,
    cwd: input.cwd,
    name: input.name,
  };
  appendFileSync(spawnLedgerPath(home), `${JSON.stringify(receipt)}\n`, "utf8");
  return receipt;
}

/**
 * Read receipts, optionally scoped to a parent provider id. Malformed and
 * partial lines are ignored: a crash can leave the last append incomplete, and
 * that must not make earlier receipts unreadable.
 *
 * The same parent/backend/child triple is coalesced to its last entry, so a
 * re-adoption after a restart updates the historical cwd/name without growing
 * duplicate rows in the result.
 */
export function readSpawnReceipts(
  home: string,
  parentProviderId?: string,
): SpawnReceipt[] {
  const path = spawnLedgerPath(home);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const byTriple = new Map<string, SpawnReceipt>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const receipt = parseReceipt(value);
    if (receipt === null) continue;
    if (
      parentProviderId !== undefined &&
      receipt.parentProviderId !== parentProviderId
    ) {
      continue;
    }
    const key = `${receipt.parentProviderId}\u0000${receipt.backend}\u0000${receipt.childProviderId}`;
    byTriple.set(key, receipt);
  }
  return [...byTriple.values()].sort(
    (left, right) =>
      left.at.localeCompare(right.at) ||
      left.childProviderId.localeCompare(right.childProviderId),
  );
}

function parseReceipt(value: unknown): SpawnReceipt | null {
  if (value === null || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (object.version !== 1) return null;
  const at = stringField(object, "at");
  const parentProviderId = stringField(object, "parentProviderId");
  const childProviderId = stringField(object, "childProviderId");
  const childSessionId = stringField(object, "childSessionId");
  const backend = stringField(object, "backend");
  const cwd = stringField(object, "cwd");
  if (
    at === null ||
    parentProviderId === null ||
    childProviderId === null ||
    childSessionId === null ||
    backend === null ||
    cwd === null
  ) {
    return null;
  }
  const parentSessionId = nullableStringField(object, "parentSessionId");
  const name = nullableStringField(object, "name");
  if (parentSessionId === undefined || name === undefined) return null;
  return {
    version: 1,
    at,
    parentProviderId,
    parentSessionId,
    childProviderId,
    childSessionId,
    backend,
    cwd,
    name,
  };
}

function stringField(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** `undefined` means malformed; `null` is a valid absent value. */
function nullableStringField(
  object: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = object[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}
