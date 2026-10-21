import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateWait, type WaitState } from "../../src/session/waits.js";

function state(overrides: Partial<WaitState> = {}): WaitState {
  return {
    status: "idle",
    queued: 0,
    awaitingInput: false,
    terminal: false,
    ...overrides,
  };
}

test("idle is satisfied only by idle; a terminal session reports exit", () => {
  assert.deepEqual(evaluateWait("idle", state()), {
    satisfied: true,
    reason: "idle",
  });
  assert.deepEqual(evaluateWait("idle", state({ status: "busy" })), {
    satisfied: false,
    reason: "pending",
  });
  assert.deepEqual(
    evaluateWait("idle", state({ status: "closed", terminal: true })),
    { satisfied: false, reason: "exit" },
  );
});

test("settled treats idle-with-empty-queue, blocked input, and exit as done", () => {
  assert.deepEqual(evaluateWait("settled", state()), {
    satisfied: true,
    reason: "idle",
  });
  assert.deepEqual(
    evaluateWait("settled", state({ status: "waiting_permission", awaitingInput: true })),
    { satisfied: true, reason: "permission" },
  );
  assert.deepEqual(
    evaluateWait("settled", state({ status: "idle", queued: 2 })),
    { satisfied: false, reason: "pending" },
  );
  assert.deepEqual(
    evaluateWait("settled", state({ status: "failed", terminal: true })),
    { satisfied: true, reason: "exit" },
  );
});

test("permission and exit name the condition they observe", () => {
  assert.deepEqual(
    evaluateWait("permission", state({ status: "waiting_permission", awaitingInput: true })),
    { satisfied: true, reason: "permission" },
  );
  assert.deepEqual(
    evaluateWait("permission", state({ status: "closed", terminal: true })),
    { satisfied: false, reason: "exit" },
  );
  assert.deepEqual(
    evaluateWait("exit", state({ status: "busy" })),
    { satisfied: false, reason: "pending" },
  );
  assert.deepEqual(
    evaluateWait("exit", state({ status: "closed", terminal: true })),
    { satisfied: true, reason: "exit" },
  );
});
