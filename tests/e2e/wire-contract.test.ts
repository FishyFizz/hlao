import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import type {
  BackendsListResult,
  CloseResult,
  HelloResult,
  PermitResult,
  ProtocolCapability,
  ReadResult,
  SendResult,
  SpawnResult,
  WaitResult,
} from "../../src/protocol.js";
import {
  WIRE_PROTOCOL_MAJOR,
  WIRE_PROTOCOL_VERSION,
} from "../../src/protocol.js";
import { readLock, type LockInfo } from "../../src/lock.js";
import { Harness } from "./harness.js";

interface WireResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

/** One request per connection, raw NDJSON: no CLI, no client library. */
function request(
  lock: LockInfo,
  method: string,
  params: unknown = {},
  callerSessionId?: string,
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
          ...(callerSessionId !== undefined ? { callerSessionId } : {}),
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

function ok<T>(response: WireResponse): T {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result as T;
}

test("a raw socket client can observe and control every session", async () => {
  const harness = new Harness();
  try {
    await harness.run(["status", "--start"]);
    const lock = readLock(harness.home);
    assert.ok(lock, "the supervisor lock exists");

    const hello = ok<HelloResult>(
      await request(lock, "hello", {
        protocolVersion: WIRE_PROTOCOL_VERSION,
      }),
    );
    assert.deepEqual(hello.protocolVersion, WIRE_PROTOCOL_VERSION);
    const expected: ProtocolCapability[] = [
      "backends.list",
      "session.usage",
      "read.filters",
      "read.before",
      "wait.multi",
      "send.messageId",
      "send.idempotency",
      "spawn.idempotency",
      "spawn.createdBy",
    ];
    for (const capability of expected) {
      assert.ok(hello.capabilities.includes(capability), capability);
    }

    const mismatch = await request(lock, "hello", {
      protocolVersion: { major: WIRE_PROTOCOL_MAJOR + 1, minor: 0 },
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error?.code, "version_mismatch");

    const backends = ok<BackendsListResult>(
      await request(lock, "backends.list", { cwd: process.cwd() }),
    );
    const fake = backends.backends.find((backend) => backend.name === "fake");
    assert.ok(fake);
    assert.equal(fake.source, "user");
    assert.equal(fake.available, true);

    const local = await harness.json<{
      agents: { name: string; source: string; available: boolean }[];
    }>(["agents", "--cwd", process.cwd()]);
    assert.deepEqual(
      local.value.agents.map((agent) => [
        agent.name,
        agent.source,
        agent.available,
      ]),
      backends.backends.map((backend) => [
        backend.name,
        backend.source,
        backend.available,
      ]),
    );

    const first = ok<SpawnResult>(
      await request(lock, "sessions.spawn", { backend: "fake" }),
    );
    const second = ok<SpawnResult>(
      await request(lock, "sessions.spawn", { backend: "fake" }),
    );

    const sent = ok<SendResult>(
      await request(lock, "sessions.send", {
        sessionId: first.session.id,
        text: "hello from the wire",
        wait: true,
        timeoutMs: 15_000,
      }),
    );
    assert.equal(sent.completed, true);

    const messages = ok<ReadResult>(
      await request(lock, "sessions.read", {
        sessionId: first.session.id,
        since: 0,
        types: ["agent.message"],
        limit: 100,
      }),
    );
    assert.ok(messages.events.length > 0);
    assert.ok(messages.events.every((event) => event.type === "agent.message"));
    assert.equal(typeof messages.earliestRetainedSeq, "number");
    assert.ok("nextBefore" in messages);

    const older = ok<ReadResult>(
      await request(lock, "sessions.read", {
        sessionId: first.session.id,
        before: messages.lastSeq + 1,
        limit: 2,
      }),
    );
    assert.ok(older.events.length > 0);
    assert.deepEqual(
      older.events.map((event) => event.seq),
      [...older.events.map((event) => event.seq)].sort((left, right) => left - right),
    );

    const waited = ok<WaitResult>(
      await request(lock, "sessions.wait", {
        sessionIds: [first.session.id, second.session.id],
        mode: "all",
        until: "idle",
        timeoutMs: 5_000,
      }),
    );
    assert.equal(waited.satisfied, true);
    assert.equal(waited.results.length, 2);
    assert.ok(waited.results.every((entry) => entry.satisfied));

    ok<CloseResult>(
      await request(lock, "sessions.close", { sessionId: first.session.id }),
    );
    ok<CloseResult>(
      await request(lock, "sessions.close", { sessionId: second.session.id }),
    );
  } finally {
    await harness.cleanup();
  }
});

test("a raw client can answer a pending permission", async () => {
  const harness = new Harness();
  try {
    await harness.run(["status", "--start"]);
    const lock = readLock(harness.home);
    assert.ok(lock);

    const spawned = ok<SpawnResult>(
      await request(lock, "sessions.spawn", {
        backend: "fake",
        prompt: "ask first",
        permissionPolicy: "ask",
        env: { FAKE_MODE: "permission" },
      }),
    );

    const waiting = ok<WaitResult>(
      await request(lock, "sessions.wait", {
        sessionId: spawned.session.id,
        until: "permission",
        timeoutMs: 15_000,
      }),
    );
    assert.equal(waiting.satisfied, true);
    const pending = waiting.results[0]?.session.pendingPermission;
    assert.ok(pending);
    const allow = pending.options.find((option) =>
      option.kind.startsWith("allow"),
    );
    assert.ok(allow);

    const permitted = ok<PermitResult>(
      await request(lock, "sessions.permit", {
        sessionId: spawned.session.id,
        requestId: pending.requestId,
        optionId: allow.optionId,
      }),
    );
    assert.equal(permitted.requestId, pending.requestId);
    assert.equal(permitted.optionId, allow.optionId);
    assert.equal(permitted.by, "operator");

    ok<CloseResult>(
      await request(lock, "sessions.close", {
        sessionId: spawned.session.id,
        force: true,
      }),
    );
  } finally {
    await harness.cleanup();
  }
});
