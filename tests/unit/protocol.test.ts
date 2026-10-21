import assert from "node:assert/strict";
import { test } from "node:test";
import { HlaoError } from "../../src/errors.js";
import {
  parseEnvelope,
  parseParams,
  type HelloParams,
  type ReadParams,
  type SpawnParams,
  type SubscribeParams,
  type UnsubscribeParams,
  type WaitParams,
} from "../../src/protocol.js";

test("envelope parsing normalizes the caller", () => {
  const envelope = parseEnvelope({
    id: 7,
    method: "hello",
    params: {},
    token: "secret",
  });
  assert.equal(envelope.id, 7);
  assert.equal(envelope.callerSessionId, null);
  assert.deepEqual(envelope.params, {});

  const caller = parseEnvelope({
    id: 1,
    method: "sessions.list",
    token: "secret",
    callerSessionId: "abc123",
  });
  assert.equal(caller.callerSessionId, "abc123");
});

test("envelope parsing rejects malformed requests", () => {
  const cases: unknown[] = [
    null,
    {},
    { id: -1, method: "hello", token: "x" },
    { id: 1, method: "", token: "x" },
    { id: 1, method: "hello" },
    { id: 1, method: "hello", token: "x", extra: true },
  ];
  for (const value of cases) {
    assert.throws(
      () => parseEnvelope(value),
      (error: unknown) =>
        error instanceof HlaoError && error.code === "bad_request",
    );
  }
});

test("spawn params validate and default", () => {
  const params = parseParams("sessions.spawn", {
    backend: "fake",
    cwd: "C:\\work",
    wait: true,
  }) as SpawnParams;
  assert.equal(params.backend, "fake");
  assert.equal(params.wait, true);

  assert.throws(
    () => parseParams("sessions.spawn", { backend: "fake", cwd: "relative" }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
  assert.throws(
    () => parseParams("sessions.spawn", { backend: "fake", unexpected: 1 }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );

  const resumed = parseParams("sessions.spawn", {
    backend: "fake",
    resumeSessionId: "provider-1",
  }) as SpawnParams;
  assert.equal(resumed.resumeSessionId, "provider-1");

  const forked = parseParams("sessions.spawn", {
    backend: "fake",
    forkSessionId: "provider-1",
  }) as SpawnParams;
  assert.equal(forked.forkSessionId, "provider-1");

  assert.throws(
    () =>
      parseParams("sessions.spawn", {
        backend: "fake",
        resumeSessionId: "provider-1",
        forkSessionId: "provider-1",
      }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
});

test("wait defaults to idle and validates the condition", () => {
  const params = parseParams("sessions.wait", { sessionId: "abc" }) as WaitParams;
  assert.equal(params.until, "idle");
  assert.throws(
    () => parseParams("sessions.wait", { sessionId: "abc", until: "soon" }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
});

test("read limits are bounded", () => {
  assert.throws(
    () => parseParams("sessions.read", { sessionId: "abc", limit: 1_001 }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
  assert.throws(
    () => parseParams("sessions.read", { sessionId: "abc", since: -1 }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
});

test("send text must be present", () => {
  assert.throws(
    () => parseParams("sessions.send", { sessionId: "abc", text: "" }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
});

test("hello accepts an optional major.minor version", () => {
  const empty = parseParams("hello", {});
  assert.equal(empty.protocolVersion, undefined);

  const versioned = parseParams("hello", {
    protocolVersion: { major: 1, minor: 1 },
  });
  assert.deepEqual(versioned.protocolVersion, { major: 1, minor: 1 });

  assert.throws(
    () => parseParams("hello", { protocolVersion: { major: 1 } }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
  assert.throws(
    () => parseParams("hello", { protocolVersion: 1 }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
});

test("backends.list validates an absolute cwd", () => {
  assert.deepEqual(parseParams("backends.list", {}), { cwd: undefined });
  assert.deepEqual(parseParams("backends.list", { cwd: "C:\\work" }), {
    cwd: "C:\\work",
  });
  assert.throws(
    () => parseParams("backends.list", { cwd: "relative" }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
});

test("read filters validate and since/before are exclusive", () => {
  const params = parseParams("sessions.read", {
    sessionId: "abc",
    types: ["tool.call", "agent.message"],
    turn: 2,
    grep: "needle",
  });
  assert.deepEqual(params.types, ["tool.call", "agent.message"]);
  assert.equal(params.turn, 2);
  assert.equal(params.grep, "needle");

  assert.throws(
    () => parseParams("sessions.read", { sessionId: "abc", types: ["nope"] }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
  assert.throws(
    () =>
      parseParams("sessions.read", {
        sessionId: "abc",
        since: 1,
        before: 2,
      }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
});

test("read time, regex, and context filters validate together", () => {
  const params = parseParams("sessions.read", {
    sessionId: "abc",
    grep: "^prompt\\.sent$",
    regex: true,
    afterAt: "2026-10-20T10:00:00Z",
    beforeAt: "2026-10-20T11:00:00Z",
    context: 2,
  }) as ReadParams;
  assert.equal(params.regex, true);
  assert.equal(params.context, 2);
  assert.equal(params.afterAt, "2026-10-20T10:00:00.000Z");
  assert.equal(params.beforeAt, "2026-10-20T11:00:00.000Z");

  for (const bad of [
    { sessionId: "abc", regex: true },
    { sessionId: "abc", grep: "[", regex: true },
    { sessionId: "abc", afterAt: "not-a-time" },
    {
      sessionId: "abc",
      afterAt: "2026-10-20T11:00:00Z",
      beforeAt: "2026-10-20T10:00:00Z",
    },
    { sessionId: "abc", context: 21 },
    { sessionId: "abc", context: -1 },
    { sessionId: "abc", context: 1.5 },
  ]) {
    assert.throws(
      () => parseParams("sessions.read", bad),
      (error: unknown) =>
        error instanceof HlaoError && error.code === "bad_request",
      JSON.stringify(bad),
    );
  }
});

test("wait accepts one id or a list, never both", () => {
  const single = parseParams("sessions.wait", { sessionId: "abc" }) as WaitParams;
  assert.equal(single.sessionId, "abc");
  assert.equal(single.sessionIds, undefined);

  const many = parseParams("sessions.wait", {
    sessionIds: ["abc", "def"],
    mode: "all",
  }) as WaitParams;
  assert.deepEqual(many.sessionIds, ["abc", "def"]);
  assert.equal(many.mode, "all");

  for (const bad of [
    {},
    { sessionId: "abc", sessionIds: ["abc"] },
    { sessionIds: [] },
    { sessionIds: ["abc", "abc"] },
    { sessionIds: ["abc", "def"], since: 1 },
    { sessionIds: ["abc", "def"], mode: "first" },
  ]) {
    assert.throws(
      () => parseParams("sessions.wait", bad),
      (error: unknown) =>
        error instanceof HlaoError && error.code === "bad_request",
    );
  }
});

test("hello can request a persistent stream", () => {
  const plain = parseParams("hello", {}) as HelloParams;
  assert.equal(plain.stream, undefined);

  const persistent = parseParams("hello", {
    stream: { persistent: true },
  }) as HelloParams;
  assert.deepEqual(persistent.stream, { persistent: true });

  for (const bad of [
    { stream: { persistent: "yes" } },
    { stream: { other: true } },
    { stream: true },
  ]) {
    assert.throws(
      () => parseParams("hello", bad),
      (error: unknown) =>
        error instanceof HlaoError && error.code === "bad_request",
    );
  }
});

test("stream.subscribe requires a scope and validates cursors", () => {
  const fleet = parseParams("stream.subscribe", {
    fleet: true,
  }) as SubscribeParams;
  assert.equal(fleet.fleet, true);

  const scoped = parseParams("stream.subscribe", {
    sessionIds: ["abc"],
    since: { abc: 4 },
  }) as SubscribeParams;
  assert.deepEqual(scoped.sessionIds, ["abc"]);
  assert.deepEqual(scoped.since, { abc: 4 });

  for (const bad of [
    {},
    { sessionIds: [] },
    { sessionIds: ["abc", "abc"] },
    { fleet: "yes" },
    { sessionIds: ["abc"], since: { abc: -1 } },
    { sessionIds: ["abc"], since: { abc: 1.5 } },
    { sessionIds: ["abc"], since: { "": 1 } },
  ]) {
    assert.throws(
      () => parseParams("stream.subscribe", bad),
      (error: unknown) =>
        error instanceof HlaoError && error.code === "bad_request",
    );
  }
});

test("stream.unsubscribe requires a subscription id", () => {
  const params = parseParams("stream.unsubscribe", {
    subscription: 3,
  }) as UnsubscribeParams;
  assert.equal(params.subscription, 3);

  assert.throws(
    () => parseParams("stream.unsubscribe", {}),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "bad_request",
  );
});
