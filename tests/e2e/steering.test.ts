import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  waitFor,
  type GetValue,
  type ReadValue,
  type SendValue,
  type SpawnValue,
} from "./harness.js";

/** Spawn a session whose first turn stays busy for `delayMs`. */
async function spawnSlow(
  harness: Harness,
  delayMs: number,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "slow work",
    "--env",
    "FAKE_MODE=slow",
    "--env",
    `FAKE_DELAY_MS=${delayMs}`,
    ...Object.entries(extraEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
  ]);
  assert.equal(spawned.code, 0, spawned.value ? "" : String(spawned.code));
  const id = spawned.value.session.id;
  await harness.waitForSession(id, "busy");
  return id;
}

/** Spawn an idle session to act as the agent caller. */
async function spawnCaller(harness: Harness): Promise<string> {
  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "caller", "--wait"]);
  assert.equal(spawned.code, 0);
  return spawned.value.session.id;
}

async function events(harness: Harness, id: string): Promise<ReadValue["events"]> {
  const read = await harness.json<ReadValue>(["read", id, "--limit", "1000"]);
  assert.equal(read.code, 0);
  return read.value.events;
}

test("an agent send steers into a running turn by default", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const target = await spawnSlow(harness, 1_500);
  const caller = await spawnCaller(harness);

  const sent = await harness.json<SendValue>(["send", target, "steer me"], {
    env: { HLAO_SESSION_ID: caller },
  });
  assert.equal(sent.code, 0);
  assert.equal(sent.value.steered, true);
  assert.equal(sent.value.queued, false);
  assert.equal(sent.value.turn, 1);

  // The injected text joins the running turn instead of starting a new one.
  await harness.waitForSession(target, "idle");
  const log = await events(harness, target);
  const steered = log.find((event) => event.type === "prompt.steered");
  assert.ok(steered, "prompt.steered event");
  assert.equal(steered.data.text, "steer me");
  assert.ok(
    log.some(
      (event) =>
        event.type === "agent.message" &&
        JSON.stringify(event.data).includes("steered: steer me"),
    ),
    "the adapter saw the injected message",
  );
  assert.equal(
    log.filter((event) => event.type === "prompt.sent").length,
    1,
    "steering must not start a second turn",
  );
});

test("an operator send queues and --steer injects", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const target = await spawnSlow(harness, 1_500);

  const queued = await harness.json<SendValue>(["send", target, "queued note"]);
  assert.equal(queued.code, 0);
  assert.equal(queued.value.steered, undefined);
  assert.equal(queued.value.queued, true);

  const steered = await harness.json<SendValue>(["send", target, "steer note", "--steer"]);
  assert.equal(steered.code, 0);
  assert.equal(steered.value.steered, true);
  assert.equal(steered.value.queued, false);

  await harness.waitForSession(target, "idle");
  const log = await events(harness, target);
  assert.ok(log.some((event) => event.type === "prompt.steered"));
  assert.ok(
    log.some(
      (event) =>
        event.type === "prompt.queued" && event.data.messageId === queued.value.messageId,
    ),
    "the operator message is visible in the queue",
  );
  // The queued message still gets its own turn after the steered one ends.
  const sent = log.filter((event) => event.type === "prompt.sent");
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.data.messageId, queued.value.messageId);
});

test("steering falls back to the queue when the adapter does not advertise it", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const target = await spawnSlow(harness, 1_500, { FAKE_NO_STEERING: "1" });
  const caller = await spawnCaller(harness);

  const session = await harness.json<GetValue>(["get", target]);
  assert.equal(session.value.session.steeringSupported, false);

  const sent = await harness.json<SendValue>(["send", target, "no steering here"], {
    env: { HLAO_SESSION_ID: caller },
  });
  assert.equal(sent.code, 0);
  assert.equal(sent.value.steered, undefined);
  assert.equal(sent.value.queued, true);

  await harness.run(["cancel", target]);
  await waitFor(
    async () => (await harness.json<GetValue>(["get", target])).value.session.settled,
    "the cancelled session to settle",
    20_000,
  );
  const log = await events(harness, target);
  assert.equal(log.some((event) => event.type === "prompt.steered"), false);
});

test("an idle target runs the prompt directly", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "start", "--wait"]);
  assert.equal(spawned.code, 0);
  const target = spawned.value.session.id;
  const caller = await spawnCaller(harness);

  const sent = await harness.json<SendValue>(["send", target, "idle note"], {
    env: { HLAO_SESSION_ID: caller },
  });
  assert.equal(sent.code, 0);
  assert.equal(sent.value.steered, undefined);
  assert.equal(sent.value.queued, false);
  assert.equal(sent.value.completed, false);

  await harness.waitForSession(target, "idle");
  const log = await events(harness, target);
  assert.ok(
    log.some(
      (event) => event.type === "prompt.sent" && event.data.messageId === sent.value.messageId,
    ),
  );
});
