import assert from "node:assert/strict";
import { test } from "node:test";
import { HlaoError } from "../../src/errors.js";
import {
  parseEnvelope,
  parseParams,
  type SpawnParams,
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
