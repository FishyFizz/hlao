import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import { readLock, type LockInfo } from "../../src/lock.js";
import { Harness, waitFor, type SpawnValue } from "./harness.js";

interface WireResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

interface OpenRequest {
  response: Promise<WireResponse>;
  close: () => void;
}

/** Keep the connection open: a blocking request does not answer immediately. */
function openRequest(
  lock: LockInfo,
  method: string,
  params: unknown,
  callerSessionId?: string,
): OpenRequest {
  const socket = connect(lock.endpoint);
  let buffer = "";
  let settle!: (value: WireResponse) => void;
  let fail!: (error: Error) => void;
  const response = new Promise<WireResponse>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({
        id: 1,
        method,
        params,
        token: lock.token,
        ...(callerSessionId !== undefined ? { callerSessionId } : {}),
      })}\n`,
    );
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    try {
      settle(JSON.parse(buffer.slice(0, newline)) as WireResponse);
    } catch (error) {
      fail(error as Error);
    }
    socket.destroy();
  });
  socket.on("error", (error) => fail(error));
  return { response, close: () => socket.destroy() };
}

/** A session that stays inside its turn until cancelled. */
async function spawnHold(harness: Harness, name: string): Promise<string> {
  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    name,
    "--env",
    "FAKE_MODE=never",
  ]);
  const id = spawned.value.session.id;
  await harness.json(["send", id, "hold"]);
  await harness.waitForSession(id, "busy");
  return id;
}

test("a reply that waits on a session waiting on the caller is rejected", async () => {
  const harness = new Harness();
  try {
    await harness.run(["status", "--start"]);
    const lock = readLock(harness.home);
    assert.ok(lock, "the supervisor lock exists");

    const a = await spawnHold(harness, "a");
    const b = await spawnHold(harness, "b");

    // A, inside its turn, sends to B and waits for B's turn.
    const aWaits = openRequest(
      lock,
      "sessions.send",
      { sessionId: b, text: "question", wait: true },
      a,
    );
    await waitFor(async () => {
      const queue = await harness.json<{ queue: { messageId: string }[] }>([
        "queue",
        b,
      ]);
      return queue.value.queue.length > 0;
    }, "A's message to queue behind B's turn");

    // B replying with --wait would wait for a turn queued behind A's turn.
    const reply = openRequest(
      lock,
      "sessions.send",
      { sessionId: a, text: "reply", wait: true },
      b,
    );
    const rejected = await reply.response;
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.error?.code, "bad_request");
    assert.match(
      rejected.error?.message ?? "",
      new RegExp(`wait cycle: ${b} -> ${a} -> ${b}`),
    );

    // B's wait on A closes the same cycle.
    const waiting = openRequest(
      lock,
      "sessions.wait",
      { sessionId: a, until: "settled" },
      b,
    );
    const waitRejected = await waiting.response;
    assert.equal(waitRejected.ok, false, JSON.stringify(waitRejected));
    assert.equal(waitRejected.error?.code, "bad_request");
    assert.match(
      waitRejected.error?.message ?? "",
      new RegExp(`wait cycle: ${b} -> ${a} -> ${b}`),
    );

    // The fix the error asks for: send the reply without --wait.
    const plain = openRequest(
      lock,
      "sessions.send",
      { sessionId: a, text: "reply" },
      b,
    );
    const accepted = await plain.response;
    assert.equal(accepted.ok, true, JSON.stringify(accepted));

    aWaits.close();
    await harness.run(["cancel", a]);
    await harness.run(["cancel", b]);
  } finally {
    await harness.cleanup();
  }
});

test("waiting on your own turn to settle is rejected; waiting for a change is not", async () => {
  const harness = new Harness();
  try {
    await harness.run(["status", "--start"]);
    const lock = readLock(harness.home);
    assert.ok(lock, "the supervisor lock exists");

    const a = await spawnHold(harness, "a");

    const self = await openRequest(
      lock,
      "sessions.wait",
      { sessionId: a, until: "idle" },
      a,
    ).response;
    assert.equal(self.ok, false, JSON.stringify(self));
    assert.equal(self.error?.code, "bad_request");
    assert.match(self.error?.message ?? "", new RegExp(`wait cycle: ${a} -> ${a}`));

    // A change filtered to events that only exist after this turn ends is the
    // same deadlock in disguise.
    const lateChange = await openRequest(
      lock,
      "sessions.wait",
      {
        sessionId: a,
        until: "change",
        types: ["prompt.sent"],
        timeoutMs: 250,
      },
      a,
    ).response;
    assert.equal(lateChange.ok, false, JSON.stringify(lateChange));
    assert.equal(lateChange.error?.code, "bad_request");
    assert.match(
      lateChange.error?.message ?? "",
      new RegExp(`wait cycle: ${a} -> ${a}`),
    );

    // A change can arrive during the current turn (a queued prompt), so it is
    // the safe way to wait for an inbound reply.
    const change = await openRequest(
      lock,
      "sessions.wait",
      { sessionId: a, until: "change", timeoutMs: 250 },
      a,
    ).response;
    assert.equal(change.ok, true, JSON.stringify(change));
    const result = change.result as { satisfied: boolean; reason: string };
    assert.equal(result.satisfied, false);
    assert.equal(result.reason, "timeout");

    await harness.run(["cancel", a]);
  } finally {
    await harness.cleanup();
  }
});
