import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type ReadValue,
  type SpawnValue,
} from "./harness.js";

function enableLoad(harness: Harness): void {
  harness.updateConfig((config) => {
    const backends = config.backends as Record<
      string,
      { env?: Record<string, string> }
    >;
    backends.fake!.env = { FAKE_LOAD_SESSION: "1" };
  });
}

test("a provider session is reattached after the supervisor restarts", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  enableLoad(harness);

  const first = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--wait",
    "--no-skill",
  ]);
  assert.equal(first.code, 0);
  const providerId = first.value.session.agentSessionId;
  assert.ok(providerId, "spawn must report the durable provider handle");
  assert.match(providerId!, /^fake-\d+$/);
  assert.equal(first.value.resumed, undefined);

  // A supervisor restart discards the live table and its event log. The
  // provider id is the only durable handle the spawner kept.
  await harness.run(["down", "--force"], { timeoutMs: 15_000 });

  const resumed = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--resume",
    providerId!,
    "--cwd",
    process.cwd(),
    "--no-skill",
  ]);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.value.resumed, true);
  assert.equal(resumed.value.session.agentSessionId, providerId);
  assert.equal(resumed.value.session.status, "idle");

  const read = await harness.json<ReadValue>(["read", resumed.value.session.id, "--since", "0"]);
  assert.equal(read.code, 0);
  const resumedEvent = read.value.events.find(
    (event) => event.type === "session.resumed",
  );
  assert.ok(resumedEvent, "resume emits a session.resumed event");
  assert.equal(resumedEvent!.data.agentSessionId, providerId);
  assert.equal(resumedEvent!.data.historyEvents, 3);

  const replayed = read.value.events.filter((event) => event.replay === true);
  assert.equal(replayed.length, 3, "every replayed event is marked");
  assert.ok(
    replayed.some((event) => event.type === "user.message"),
    "replayed history includes the original user message",
  );
  assert.ok(
    replayed.some((event) => event.type === "agent.message"),
    "replayed history includes the original agent reply",
  );
  assert.ok(
    read.value.events.some(
      (event) => event.type === "session.initialized" && event.data.resumed === true,
    ),
    "initialization records that the session was resumed",
  );

  // The replayed history sits before initialization, in provider order.
  const initializedAt = read.value.events.findIndex(
    (event) => event.type === "session.initialized",
  );
  const lastReplayAt = read.value.events.findLastIndex(
    (event) => event.replay === true,
  );
  assert.ok(lastReplayAt < initializedAt);

  // A second attach while the session is live returns it instead of opening a
  // second adapter against the same transcript.
  const again = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--resume",
    providerId!,
    "--cwd",
    process.cwd(),
    "--no-skill",
  ]);
  assert.equal(again.code, 0);
  assert.equal(again.value.session.id, resumed.value.session.id);
  assert.equal(again.value.duplicate, true);
  assert.equal(again.value.resumed, true);
});

test("resume fails loudly when the backend cannot load sessions", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const first = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "--no-skill",
  ]);
  const providerId = first.value.session.agentSessionId;
  assert.ok(providerId);

  await harness.run(["down", "--force"], { timeoutMs: 15_000 });

  const failed = await harness.json<JsonError>([
    "spawn",
    "fake",
    "--resume",
    providerId!,
    "--no-skill",
  ]);
  assert.equal(failed.code, 1);
  assert.equal(failed.value.ok, false);
  assert.equal(failed.value.error.code, "spawn_failed");
  assert.match(failed.value.error.message, /does not advertise loadSession/);
});
