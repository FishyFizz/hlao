import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupervisorConnection } from "../../src/client.js";
import { HlaoError } from "../../src/errors.js";
import { ensureCapability } from "../../src/cli/context.js";

function connection(
  endpoint: string,
  capabilities: string[] | undefined,
  calls: { count: number },
): SupervisorConnection {
  return {
    lock: {
      pid: 1,
      token: "t",
      endpoint,
      protocolVersion: 1,
      startedAt: "2026-10-20T00:00:00.000Z",
      version: "0.3.0",
      state: "running",
    },
    request: async () => {
      calls.count += 1;
      return {
        protocolVersion: capabilities === undefined ? 1 : { major: 1, minor: 1 },
        capabilities,
        pid: 1,
        startedAt: "2026-10-20T00:00:00.000Z",
        version: "0.3.0",
        sessions: 0,
        configHash: "missing",
      };
    },
  } as unknown as SupervisorConnection;
}

test("a capability missing from a running supervisor is a clear mismatch", async () => {
  const calls = { count: 0 };
  const old = connection("old-1", undefined, calls);
  await assert.rejects(
    ensureCapability(old, "wait.multi", "wait with several ids"),
    (error: unknown) =>
      error instanceof HlaoError &&
      error.code === "version_mismatch" &&
      /predates it/.test(error.message),
  );
  assert.equal(calls.count, 1);
});

test("a present capability passes and is cached per endpoint", async () => {
  const calls = { count: 0 };
  const current = connection("new-1", ["wait.multi", "read.filters"], calls);
  await ensureCapability(current, "wait.multi", "wait with several ids");
  await ensureCapability(current, "read.filters", "read filters");
  assert.equal(calls.count, 1);

  const missing = connection("new-2", [], { count: 0 });
  await assert.rejects(
    ensureCapability(missing, "wait.multi", "wait with several ids"),
    (error: unknown) => error instanceof HlaoError,
  );
});
