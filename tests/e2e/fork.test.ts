import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type ReadValue,
  type SpawnValue,
} from "./harness.js";

function enableFork(harness: Harness): void {
  harness.updateConfig((config) => {
    const backends = config.backends as Record<
      string,
      { env?: Record<string, string> }
    >;
    backends.fake!.env = {
      FAKE_LOAD_SESSION: "1",
      FAKE_FORK_SESSION: "1",
    };
  });
}

test("a provider session is forked without touching the source", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  enableFork(harness);

  const source = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--wait",
    "--no-skill",
  ]);
  assert.equal(source.code, 0);
  const sourceProviderId = source.value.session.agentSessionId;
  assert.ok(sourceProviderId);

  const forked = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--fork",
    sourceProviderId!,
    "--cwd",
    process.cwd(),
    "--no-skill",
  ]);
  assert.equal(forked.code, 0);
  assert.equal(forked.value.forked, true);
  assert.equal(forked.value.resumed, undefined);
  assert.notEqual(forked.value.session.id, source.value.session.id);
  assert.match(forked.value.session.agentSessionId!, /^fake-\d+-fork-\d+$/);
  assert.equal(forked.value.session.forkedFrom, sourceProviderId);

  const read = await harness.json<ReadValue>([
    "read",
    forked.value.session.id,
    "--since",
    "0",
  ]);
  const forkedEvent = read.value.events.find(
    (event) => event.type === "session.forked",
  );
  assert.ok(forkedEvent, "fork emits a session.forked event");
  assert.equal(forkedEvent!.data.forkedFrom, sourceProviderId);
  assert.equal(forkedEvent!.data.historyLoaded, true);
  assert.equal(forkedEvent!.data.historyEvents, 3);
  assert.equal(
    read.value.events.filter((event) => event.replay === true).length,
    3,
  );

  // The source is still live and unchanged.
  const sourceRead = await harness.json<ReadValue>([
    "read",
    source.value.session.id,
  ]);
  assert.equal(sourceRead.value.session.status, "idle");
  assert.equal(sourceRead.value.session.agentSessionId, sourceProviderId);
  assert.equal(sourceRead.value.session.forkedFrom, null);
});

test("fork requires the backend capability and cannot combine with resume", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const source = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--no-skill",
  ]);
  const providerId = source.value.session.agentSessionId;
  assert.ok(providerId);

  const noCapability = await harness.json<JsonError>([
    "spawn",
    "fake",
    "--fork",
    providerId!,
    "--no-skill",
  ]);
  assert.equal(noCapability.code, 1);
  assert.equal(noCapability.value.ok, false);
  assert.equal(noCapability.value.error.code, "spawn_failed");
  assert.match(noCapability.value.error.message, /does not advertise session\/fork/);

  const combined = await harness.json<JsonError>([
    "spawn",
    "fake",
    "--resume",
    providerId!,
    "--fork",
    providerId!,
    "--no-skill",
  ]);
  assert.equal(combined.code, 1);
  assert.equal(combined.value.ok, false);
  assert.match(combined.value.error.message, /cannot be combined/);
});
