import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type GetValue,
  type ListValue,
  type ReadValue,
  type SpawnValue,
} from "./harness.js";

function capabilitiesFrom(text: string): Record<string, unknown> {
  const marker = text.indexOf("caps: ");
  assert.ok(marker >= 0, `missing caps marker in ${JSON.stringify(text)}`);
  return JSON.parse(text.slice(marker + 6)) as Record<string, unknown>;
}

test("provider-native state is projected into events, views, and human output", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "signal",
    "--env",
    "FAKE_MODE=signal",
    "--wait",
    "--no-skill",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  // The adapter saw the provider-native capabilities and no subagent opt-in.
  const caps = capabilitiesFrom(spawned.value.firstTurn?.text ?? "");
  assert.deepEqual((caps.session as Record<string, unknown>).compaction, {});
  assert.deepEqual((caps.session as Record<string, unknown>).notices, {});
  assert.deepEqual(caps.plan, {});
  assert.equal(caps.subagents, undefined);

  const read = await harness.json<ReadValue>(["read", id, "--since", "0"]);
  assert.equal(read.code, 0);
  const events = read.value.events;
  const ofType = (type: string) => events.filter((event) => event.type === type);

  assert.ok(ofType("session.info").some((event) => event.data.title === "Provider Session"));
  assert.ok(
    ofType("plan").some(
      (event) => Array.isArray(event.data.entries) && event.data.entries.length === 3,
    ),
  );
  const planUpdate = ofType("plan.update").find(
    (event) => event.data.planId === "plan-1",
  );
  assert.ok(planUpdate, "plan_update carries its planId");
  assert.equal(planUpdate.data.kind, "items");
  assert.equal(
    (planUpdate.data.entries as { status: string }[])[1]?.status,
    "completed",
  );

  const compaction = ofType("compaction");
  assert.ok(
    compaction.some(
      (event) =>
        event.data.compactionId === "cmp-1" && event.data.status === "completed",
    ),
  );
  assert.ok(
    compaction.some(
      (event) => event.data.compactionId === "cmp-1" && event.data.text === "Summary of earlier work",
    ),
  );

  const providerMessages = ofType("session.message");
  assert.ok(
    providerMessages.some(
      (event) =>
        event.data.senderSessionId === "sibling" &&
        event.data.text === "provider message" &&
        event.data.chunk === false,
    ),
  );
  assert.ok(
    providerMessages.some(
      (event) =>
        event.data.messageId === "sms-2" &&
        event.data.text === "streamed provider message" &&
        event.data.chunk === true,
    ),
  );
  assert.ok(
    ofType("user.message").some(
      (event) => event.data.text === "provider user line",
    ),
  );
  assert.equal(
    events.some((event) => event.type === "raw"),
    false,
    "provider messages are no longer projected as raw",
  );

  const notices = ofType("notice");
  assert.ok(
    notices.some(
      (event) =>
        event.data.severity === "warning" &&
        String(event.data.description).includes("150000/200000"),
    ),
  );
  assert.ok(
    notices.some(
      (event) =>
        event.data.severity === "error" &&
        String(event.data.description).includes("185000/200000"),
    ),
  );

  const get = await harness.json<GetValue>(["get", id]);
  assert.equal(get.code, 0);
  assert.equal(get.value.session.title, "Provider Session");
  assert.equal(get.value.session.agentName, "fake-acp");
  assert.equal(get.value.session.agentVersion, "1.0.0");
  assert.equal(get.value.session.plan?.planId, "plan-1");
  assert.equal(get.value.session.plan?.entries?.length, 3);
  assert.equal(get.value.session.compaction?.status, "completed");
  assert.equal(get.value.session.compaction?.summary, "Summary of earlier work");

  const humanRead = await harness.run(["read", id, "--since", "0"], {
    json: false,
  });
  assert.equal(humanRead.code, 0);
  assert.match(humanRead.stdout, /session › Provider Session/);
  assert.match(humanRead.stdout, /plan › 2\/3 done · current: verify/);
  assert.match(humanRead.stdout, /compaction › Summary of earlier work/);
  assert.match(humanRead.stdout, /compaction › completed/);
  assert.match(humanRead.stdout, /from sibling › provider message/);
  assert.match(humanRead.stdout, /from sibling › streamed provider message/);
  assert.match(humanRead.stdout, /user › provider user line/);
  assert.match(humanRead.stdout, /warning › context pressure/);
  assert.match(humanRead.stdout, /error › context pressure/);
  assert.match(humanRead.stdout, /ACP session ready · fake-acp 1\.0\.0/);

  const humanGet = await harness.run(["get", id], { json: false });
  assert.equal(humanGet.code, 0);
  assert.match(humanGet.stdout, /title\s+Provider Session/);
  assert.match(humanGet.stdout, /agent\s+fake-acp@1\.0\.0/);
  assert.match(humanGet.stdout, /plan\s+2\/3 done/);
  assert.match(humanGet.stdout, /compaction completed · Summary of earlier work/);

  const list = await harness.run(["list"], { json: false });
  assert.equal(list.code, 0);
  assert.match(list.stdout, /Provider Session/);
  const wide = await harness.run(["list", "--wide"], { json: false });
  assert.equal(wide.code, 0);
  assert.match(wide.stdout, /AGENT/);
  assert.match(wide.stdout, /fake-acp@1\.0\.0/);

  const listed = await harness.json<ListValue>(["list"]);
  const view = listed.value.sessions.find((session) => session.id === id);
  assert.equal(view?.title, "Provider Session");
  assert.equal(view?.agentName, "fake-acp");
  assert.equal(view?.compaction?.status, "completed");
});

test("file, markdown, and removed plans replace or clear the view", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const file = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "file plan",
    "--env",
    "FAKE_MODE=signal",
    "--env",
    "FAKE_SIGNAL_PLAN=file",
    "--wait",
    "--no-skill",
  ]);
  assert.equal(file.code, 0);
  const fileGet = await harness.json<GetValue>(["get", file.value.session.id]);
  assert.equal(fileGet.value.session.plan?.kind, "file");
  assert.equal(fileGet.value.session.plan?.uri, "file:///plan.md");

  const markdown = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "markdown plan",
    "--env",
    "FAKE_MODE=signal",
    "--env",
    "FAKE_SIGNAL_PLAN=markdown",
    "--wait",
    "--no-skill",
  ]);
  assert.equal(markdown.code, 0);
  const markdownGet = await harness.json<GetValue>([
    "get",
    markdown.value.session.id,
  ]);
  assert.equal(markdownGet.value.session.plan?.kind, "markdown");
  assert.match(markdownGet.value.session.plan?.content ?? "", /markdown plan/);

  const removed = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "removed plan",
    "--env",
    "FAKE_MODE=signal",
    "--env",
    "FAKE_SIGNAL_PLAN=remove",
    "--wait",
    "--no-skill",
  ]);
  assert.equal(removed.code, 0);
  const removedGet = await harness.json<GetValue>([
    "get",
    removed.value.session.id,
  ]);
  assert.equal(removedGet.value.session.plan, null);
});
