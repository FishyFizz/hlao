import assert from "node:assert/strict";
import { connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

import { readLock, type LockInfo } from "../../src/lock.js";
import type {
  RecoveryReceiptsResult,
  SpawnResult,
} from "../../src/protocol.js";
import { Harness } from "./harness.js";

interface ChildrenValue {
  parentProviderId: string;
  ledger: string;
  children: {
    version: 1;
    at: string;
    parentProviderId: string;
    parentSessionId: string | null;
    childProviderId: string;
    childSessionId: string;
    backend: string;
    cwd: string;
    name: string | null;
  }[];
}

interface WireResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** One request per connection, raw NDJSON: no CLI between the test and the wire. */
function rawRequest(
  lock: LockInfo,
  method: string,
  params: unknown,
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(lock.endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`raw ${method} timed out`));
    }, 20_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: 1,
          method,
          params,
          token: lock.token,
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as WireResponse);
      } catch (error) {
        reject(error);
      }
      socket.destroy();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function enableResume(harness: Harness): void {
  const catalog = join(harness.home, "provider-catalog.jsonl");
  harness.updateConfig((config) => {
    const backends = config.backends as Record<
      string,
      { env?: Record<string, string> }
    >;
    backends.fake!.env = {
      ...(backends.fake!.env ?? {}),
      FAKE_LOAD_SESSION: "1",
      FAKE_PROVIDER_CATALOG_FILE: catalog,
    };
  });
}

test("a resumed leader finds its child by provider id after the instance is emptied", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  enableResume(harness);
  const cwd = process.cwd();

  const parent = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "lead",
    "--cwd",
    cwd,
    "--name",
    "leader",
    "--no-skill",
  ]);
  assert.equal(parent.code, 0);
  const parentProviderId = parent.value.session.agentSessionId;
  assert.ok(parentProviderId);

  // An agent caller becomes the default parent of the child.
  const child = await harness.json<SpawnResult>(
    [
      "spawn",
      "fake",
      "work",
      "--cwd",
      cwd,
      "--name",
      "worker",
      "--env",
      "FAKE_SESSION_OFFSET=100",
      "--no-skill",
    ],
    { env: { HLAO_SESSION_ID: parent.value.session.id } },
  );
  assert.equal(child.code, 0);
  assert.equal(child.value.session.parentId, parent.value.session.id);
  assert.equal(child.value.session.rootId, parent.value.session.id);
  const childProviderId = child.value.session.agentSessionId;
  assert.ok(childProviderId);

  // The machine reboots: every live session and every HLAO id is gone.
  await harness.run(["down", "--force"], { timeoutMs: 15_000 });

  // The operator resumes the leader from its provider conversation. It gets a
  // new HLAO handle but keeps the durable provider id.
  const resumed = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "--resume",
    parentProviderId!,
    "--cwd",
    cwd,
    "--name",
    "leader-again",
    "--no-skill",
  ]);
  assert.equal(resumed.code, 0);
  assert.notEqual(resumed.value.session.id, parent.value.session.id);
  assert.equal(resumed.value.session.agentSessionId, parentProviderId);

  // The resumed leader resolves its own provider id and reads the ledger.
  const receipts = await harness.json<ChildrenValue>(["children", "--self"], {
    env: { HLAO_SESSION_ID: resumed.value.session.id },
  });
  assert.equal(receipts.code, 0);
  assert.equal(receipts.value.parentProviderId, parentProviderId);
  assert.equal(receipts.value.children.length, 1);
  const receipt = receipts.value.children[0]!;
  assert.equal(receipt.childProviderId, childProviderId);
  assert.equal(receipt.childSessionId, child.value.session.id);
  assert.equal(receipt.parentProviderId, parentProviderId);
  assert.equal(receipt.parentSessionId, parent.value.session.id);
  assert.equal(receipt.backend, "fake");
  assert.equal(receipt.cwd, cwd);
  assert.equal(receipt.name, "worker");

  // Reattach the child by the provider id in the receipt. An agent caller is
  // the default parent, so the new attachment lands under the resumed leader.
  const adopted = await harness.json<SpawnResult>(
    [
      "adopt",
      "fake",
      childProviderId!,
      "--cwd",
      cwd,
      "--name",
      "worker-again",
      "--no-skill",
    ],
    { env: { HLAO_SESSION_ID: resumed.value.session.id } },
  );
  assert.equal(adopted.code, 0);
  assert.equal(adopted.value.session.agentSessionId, childProviderId);
  assert.equal(adopted.value.session.parentId, resumed.value.session.id);
  assert.equal(adopted.value.session.rootId, resumed.value.session.id);
});

test("children --provider reads the ledger without a supervisor", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const cwd = process.cwd();

  const parent = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "lead",
    "--cwd",
    cwd,
    "--name",
    "leader",
    "--no-skill",
  ]);
  assert.equal(parent.code, 0);
  const parentProviderId = parent.value.session.agentSessionId!;

  const child = await harness.json<SpawnResult>(
    [
      "spawn",
      "fake",
      "work",
      "--cwd",
      cwd,
      "--name",
      "worker",
      "--env",
      "FAKE_SESSION_OFFSET=100",
      "--no-skill",
    ],
    { env: { HLAO_SESSION_ID: parent.value.session.id } },
  );
  assert.equal(child.code, 0);

  await harness.run(["down", "--force"], { timeoutMs: 15_000 });

  const offline = await harness.json<ChildrenValue>([
    "children",
    "--provider",
    parentProviderId,
  ]);
  assert.equal(offline.code, 0);
  assert.equal(offline.value.parentProviderId, parentProviderId);
  assert.deepEqual(
    offline.value.children.map((receipt) => receipt.childProviderId),
    [child.value.session.agentSessionId],
  );
});

test("recovery.receipts live-joins a receipt to the supervisor table", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const cwd = process.cwd();

  const parent = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "lead",
    "--cwd",
    cwd,
    "--name",
    "leader",
    "--no-skill",
  ]);
  assert.equal(parent.code, 0);
  const parentProviderId = parent.value.session.agentSessionId!;

  const child = await harness.json<SpawnResult>(
    [
      "spawn",
      "fake",
      "work",
      "--cwd",
      cwd,
      "--name",
      "worker",
      "--env",
      "FAKE_SESSION_OFFSET=100",
      "--no-skill",
    ],
    { env: { HLAO_SESSION_ID: parent.value.session.id } },
  );
  assert.equal(child.code, 0);
  const childProviderId = child.value.session.agentSessionId!;

  const lock = readLock(harness.home);
  assert.ok(lock, "the supervisor lock is readable");
  const response = await rawRequest(lock!, "recovery.receipts", {});
  assert.equal(response.ok, true, JSON.stringify(response));
  const result = response.result as RecoveryReceiptsResult;
  // The parent was itself an operator root spawn, so it has a null-parent
  // receipt and is recoverable after a restart too.
  assert.equal(result.receipts.length, 2);
  const rootReceipt = result.receipts.find(
    (candidate) => candidate.childProviderId === parentProviderId,
  );
  assert.ok(rootReceipt, "the root spawn has a receipt");
  assert.equal(rootReceipt.parentProviderId, null);
  assert.equal(rootReceipt.attached, true);
  assert.equal(rootReceipt.hlaoSessionId, parent.value.session.id);
  const receipt = result.receipts.find(
    (candidate) => candidate.childProviderId === childProviderId,
  );
  assert.ok(receipt, "the child spawn has a receipt");
  assert.equal(receipt.parentProviderId, parentProviderId);
  assert.equal(receipt.childProviderId, childProviderId);
  assert.equal(receipt.backend, "fake");
  assert.equal(receipt.cwd, cwd);
  assert.equal(receipt.name, "worker");
  assert.equal(receipt.attached, true);
  assert.equal(receipt.hlaoSessionId, child.value.session.id);
  assert.ok(
    receipt.hlaoStatus !== null &&
      receipt.hlaoStatus !== "closed" &&
      receipt.hlaoStatus !== "failed",
  );
  assert.equal(receipt.parentHlaoSessionId, parent.value.session.id);

  const scoped = await rawRequest(lock!, "recovery.receipts", {
    parentProviderId,
  });
  assert.equal(scoped.ok, true, JSON.stringify(scoped));
  assert.equal(
    (scoped.result as RecoveryReceiptsResult).receipts.length,
    1,
  );

  const missing = await rawRequest(lock!, "recovery.receipts", {
    parentProviderId: "missing",
  });
  assert.equal(missing.ok, true, JSON.stringify(missing));
  assert.equal(
    (missing.result as RecoveryReceiptsResult).receipts.length,
    0,
  );
});

test("a root spawn is recoverable after a supervisor restart", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const cwd = process.cwd();

  const spawned = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "lead",
    "--cwd",
    cwd,
    "--name",
    "leader",
    "--no-skill",
  ]);
  assert.equal(spawned.code, 0);
  const providerId = spawned.value.session.agentSessionId!;
  assert.ok(providerId);

  // The machine reboots: the supervisor table is empty, but the ledger is on disk.
  await harness.run(["down", "--force"], { timeoutMs: 15_000 });
  const listed = await harness.run(["list"]);
  assert.equal(listed.code, 0);

  const lock = readLock(harness.home);
  assert.ok(lock, "the restarted supervisor writes a lock");
  const response = await rawRequest(lock!, "recovery.receipts", {});
  assert.equal(response.ok, true, JSON.stringify(response));
  const result = response.result as RecoveryReceiptsResult;
  assert.equal(result.receipts.length, 1);
  const receipt = result.receipts[0]!;
  assert.equal(receipt.parentProviderId, null);
  assert.equal(receipt.childProviderId, providerId);
  assert.equal(receipt.backend, "fake");
  assert.equal(receipt.cwd, cwd);
  assert.equal(receipt.name, "leader");
  assert.equal(receipt.attached, false);
  assert.equal(receipt.hlaoSessionId, null);
});

test("a fresh session writes no receipt until its first turn", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const cwd = process.cwd();

  // No prompt: the adapter has an id but no transcript a resume could load.
  const spawned = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "--cwd",
    cwd,
    "--name",
    "unused",
    "--no-skill",
  ]);
  assert.equal(spawned.code, 0);
  assert.equal(spawned.value.session.turn, 0);
  const sessionId = spawned.value.session.id;
  const providerId = spawned.value.session.agentSessionId!;

  const lock = readLock(harness.home);
  assert.ok(lock);
  const before = await rawRequest(lock!, "recovery.receipts", {});
  assert.equal(before.ok, true, JSON.stringify(before));
  assert.equal(
    (before.result as RecoveryReceiptsResult).receipts.length,
    0,
    "an unused session must not be offered as recoverable",
  );

  // The first turn makes the conversation durable and the receipt appears.
  const sent = await harness.json<{ messageId: string }>(
    ["send", sessionId, "go", "--wait", "--timeout", "10s"],
  );
  assert.equal(sent.code, 0);
  const after = await rawRequest(lock!, "recovery.receipts", {});
  assert.equal(after.ok, true, JSON.stringify(after));
  const receipts = (after.result as RecoveryReceiptsResult).receipts;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.childProviderId, providerId);
  assert.equal(receipts[0]?.parentProviderId, null);
  assert.equal(receipts[0]?.attached, true);
});

test("children without a provider id or a session shell is a usage error", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const result = await harness.run(["children"], { json: true });
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "bad_request");
  assert.match(payload.error.message, /--provider/);
});
