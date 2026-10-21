import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readSpawnReceipts, recordSpawnReceipt } from "../../src/ledger.js";
import { spawnLedgerPath } from "../../src/paths.js";

test("spawn receipts filter by parent provider id and coalesce re-attachments", () => {
  const home = mkdtempSync(join(tmpdir(), "hlao-ledger-"));
  try {
    recordSpawnReceipt(home, {
      at: "2026-10-21T10:00:00.000Z",
      parentProviderId: "parent-1",
      parentSessionId: "old-parent",
      childProviderId: "child-1",
      childSessionId: "old-child-1",
      backend: "claude",
      cwd: "D:/work/a",
      name: "auth-tests",
    });
    recordSpawnReceipt(home, {
      at: "2026-10-21T10:01:00.000Z",
      parentProviderId: "parent-1",
      parentSessionId: "old-parent",
      childProviderId: "child-2",
      childSessionId: "old-child-2",
      backend: "claude",
      cwd: "D:/work/a",
      name: "runner",
    });
    recordSpawnReceipt(home, {
      at: "2026-10-21T10:02:00.000Z",
      parentProviderId: "parent-2",
      parentSessionId: "other-parent",
      childProviderId: "child-3",
      childSessionId: "old-child-3",
      backend: "codex",
      cwd: "D:/work/b",
      name: null,
    });
    // Re-attaching the same provider conversation updates the historical
    // cwd/name instead of producing a second row for the parent.
    recordSpawnReceipt(home, {
      at: "2026-10-21T10:03:00.000Z",
      parentProviderId: "parent-1",
      parentSessionId: "resumed-parent",
      childProviderId: "child-1",
      childSessionId: "new-child-1",
      backend: "claude",
      cwd: "D:/work/c",
      name: "auth-tests-again",
    });

    const first = readSpawnReceipts(home, "parent-1");
    assert.deepEqual(
      first.map((receipt) => receipt.childProviderId),
      ["child-2", "child-1"],
    );
    const reattached = first.find((receipt) => receipt.childProviderId === "child-1");
    assert.equal(reattached?.cwd, "D:/work/c");
    assert.equal(reattached?.name, "auth-tests-again");
    assert.equal(reattached?.childSessionId, "new-child-1");

    assert.equal(readSpawnReceipts(home).length, 3);
    assert.equal(readSpawnReceipts(home, "missing").length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("malformed and partial ledger lines do not hide valid receipts", () => {
  const home = mkdtempSync(join(tmpdir(), "hlao-ledger-bad-"));
  try {
    recordSpawnReceipt(home, {
      at: "2026-10-21T10:00:00.000Z",
      parentProviderId: "parent-1",
      parentSessionId: null,
      childProviderId: "child-1",
      childSessionId: "child-session",
      backend: "claude",
      cwd: "D:/work/a",
      name: "auth-tests",
    });
    appendFileSync(spawnLedgerPath(home), '{"version":1,"at":"2026-10-21T10:01:00.000Z"\n');
    appendFileSync(spawnLedgerPath(home), "not json\n");
    appendFileSync(
      spawnLedgerPath(home),
      `${JSON.stringify({ version: 2, parentProviderId: "parent-1" })}\n`,
    );

    const receipts = readSpawnReceipts(home, "parent-1");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.childProviderId, "child-1");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
