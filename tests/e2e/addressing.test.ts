import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type ReadValue,
  type SendValue,
  type SpawnValue,
  type WaitValue,
} from "./harness.js";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("a unique name addresses a session and rename changes the handle", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--name",
    "builder",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;
  assert.equal(spawned.value.session.name, "builder");

  const byName = await harness.json<ReadValue>(["read", "builder"]);
  assert.equal(byName.code, 0);
  assert.equal(byName.value.session.id, id);

  const renamed = await harness.json<{ session: { name: string | null } }>([
    "rename",
    "builder",
    "foreman",
  ]);
  assert.equal(renamed.code, 0);
  assert.equal(renamed.value.session.name, "foreman");

  const oldName = await harness.json<JsonError>(["read", "builder"]);
  assert.equal(oldName.code, 1);
  assert.equal(oldName.value.error.code, "not_found");

  const byNewName = await harness.json<ReadValue>(["read", "foreman"]);
  assert.equal(byNewName.value.session.id, id);

  const cleared = await harness.json<{ session: { name: string | null } }>([
    "rename",
    "foreman",
    "--clear",
  ]);
  assert.equal(cleared.value.session.name, null);

  const closed = await harness.json<{ session: { id: string; status: string } }>([
    "close",
    id,
  ]);
  assert.equal(closed.value.session.status, "closed");
});

test("duplicate names are ambiguous but exact ids still resolve", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const first = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "one",
    "--name",
    "twin",
    "--wait",
  ]);
  const second = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "two",
    "--name",
    "twin",
    "--wait",
  ]);

  const ambiguous = await harness.json<JsonError>(["read", "twin"]);
  assert.equal(ambiguous.code, 1);
  assert.equal(ambiguous.value.error.code, "ambiguous_id");
  const details = ambiguous.value.error.details as {
    candidates: { id: string }[];
  };
  assert.deepEqual(
    new Set(details.candidates.map((candidate) => candidate.id)),
    new Set([first.value.session.id, second.value.session.id]),
  );

  const byId = await harness.json<ReadValue>(["read", first.value.session.id]);
  assert.equal(byId.code, 0);
  assert.equal(byId.value.session.id, first.value.session.id);
});

test("self-scoped commands default to HLAO_SESSION_ID inside a session", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--name",
    "scout",
    "--wait",
  ]);
  const id = spawned.value.session.id;
  const env = { HLAO_SESSION_ID: id, HLAO_NAME: "scout" };

  const implicit = await harness.json<ReadValue>(["read"], { env });
  assert.equal(implicit.code, 0);
  assert.equal(implicit.value.session.id, id);

  const explicit = await harness.json<ReadValue>(["read", "--self"], { env });
  assert.equal(explicit.code, 0);
  assert.equal(explicit.value.session.id, id);

  const conflict = await harness.json<JsonError>(["read", id, "--self"], { env });
  assert.equal(conflict.code, 1);
  assert.equal(conflict.value.error.code, "bad_request");

  const untouched = await harness.json<ReadValue>(["read", id]);
  assert.equal(untouched.code, 0);

  const sent = await harness.json<SendValue>(
    ["send", "--self", "hello self", "--wait", "--timeout", "10s"],
    { env },
  );
  assert.equal(sent.code, 0);
  assert.equal(sent.value.completed, true);
  assert.match(sent.value.text ?? "", /echo: hello self/);

  const noCaller = await harness.json<JsonError>(["read"]);
  assert.equal(noCaller.code, 1);
  assert.equal(noCaller.value.error.code, "bad_request");
});

test("spawn injects HLAO_NAME and whoami reports it", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "who",
    "--name",
    "scout",
    "--env",
    "FAKE_MODE=env",
    "--wait",
  ]);
  const text = spawned.value.firstTurn?.text ?? "";
  const injected = JSON.parse(text.slice(4)) as Record<string, string | null>;
  assert.equal(injected.name, "scout");
  assert.equal(injected.sessionId, spawned.value.session.id);

  const who = await harness.json<{
    role: string;
    sessionId: string | null;
    name: string | null;
  }>(["whoami"], {
    env: { HLAO_SESSION_ID: spawned.value.session.id, HLAO_NAME: "scout" },
  });
  assert.equal(who.value.role, "session");
  assert.equal(who.value.sessionId, spawned.value.session.id);
  assert.equal(who.value.name, "scout");
});

test("wait exits 3 when the session dies before the awaited state", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "die",
    "--env",
    "FAKE_MODE=crash",
  ]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const died = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "idle",
    "--timeout",
    "10s",
  ]);
  assert.equal(died.code, 3);
  assert.equal(died.value.reason, "exit");
  assert.equal(died.value.satisfied, false);

  const exited = await harness.json<WaitValue>([
    "wait",
    id,
    "--until",
    "exit",
    "--timeout",
    "10s",
  ]);
  assert.equal(exited.code, 0);
  assert.equal(exited.value.reason, "exit");
  assert.equal(exited.value.satisfied, true);
});

test("human wait output includes the exit code", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "die",
    "--env",
    "FAKE_MODE=crash",
  ]);
  assert.equal(spawned.code, 0);

  const waited = await harness.run(
    ["wait", spawned.value.session.id, "--until", "idle", "--timeout", "10s"],
    { json: false },
  );
  assert.equal(waited.code, 3);
  assert.match(waited.stdout, /ended before reaching "idle"/);
  assert.match(waited.stdout, /exit 3/);
});

test("human list marks the caller and reports the instance", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--name",
    "listed",
    "--wait",
  ]);
  const id = spawned.value.session.id;

  const listed = await harness.run(["list"], {
    json: false,
    env: { HLAO_SESSION_ID: id },
  });
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /instance · \d+ sessions?/);
  assert.match(listed.stdout, /SELF/);
  const selfLine = listed.stdout
    .split("\n")
    .find((line) => line.includes(id))!;
  assert.match(selfLine, /^\*/);
  assert.match(selfLine, /listed/);

  const operator = await harness.run(["list"], { json: false });
  assert.match(operator.stdout, /instance · \d+ sessions?/);
  assert.doesNotMatch(operator.stdout, /SELF/);
});

test("send accepts --prompt and warns about an inert --timeout", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "hello",
    "--wait",
  ]);
  const id = spawned.value.session.id;

  const prompted = await harness.json<SendValue>([
    "send",
    id,
    "--prompt",
    "via flag",
    "--wait",
    "--timeout",
    "10s",
  ]);
  assert.equal(prompted.code, 0);
  assert.match(prompted.value.text ?? "", /echo: via flag/);

  const inert = await harness.run(["send", id, "later", "--timeout", "1s"], {
    json: false,
  });
  assert.equal(inert.code, 0);
  assert.match(inert.stderr, /--timeout has no effect without --wait/);
  assert.doesNotMatch(inert.stdout, /has no effect/);

  const since = await harness.run(
    ["wait", id, "--until", "idle", "--since", "1"],
    { json: false },
  );
  assert.equal(since.code, 0);
  assert.match(since.stderr, /--since only affects --until change/);
});

test("parser guardrails reject extra positionals, flag-like paths, and unknown help", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const extra = await harness.json<JsonError>(["list", "extra"]);
  assert.equal(extra.code, 1);
  assert.equal(extra.value.error.code, "bad_request");
  assert.match(extra.value.error.message, /list expects 0 positional/);

  const path = await harness.json<JsonError>([
    "spawn",
    "fake",
    "hi",
    "--cwd",
    "--wait",
  ]);
  assert.equal(path.code, 1);
  assert.equal(path.value.error.code, "bad_request");
  assert.match(path.value.error.message, /--cwd expects a path/);

  const help = await harness.json<JsonError>(["help", "nope"]);
  assert.equal(help.code, 1);
  assert.equal(help.value.error.code, "bad_request");
  assert.match(help.value.error.message, /unknown help topic/);

  const whoami = await harness.json<JsonError>(["whoami", "extra"]);
  assert.equal(whoami.code, 1);
  assert.equal(whoami.value.error.code, "bad_request");

  const notFound = await harness.json<JsonError>(["read", "nosuch"]);
  assert.equal(notFound.code, 1);
  assert.equal(notFound.value.error.code, "not_found");
});

test("human output never carries adapter ANSI escapes", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "colour",
    "--env",
    "FAKE_MODE=ansi",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const read = await harness.run(["read", spawned.value.session.id], {
    json: false,
  });
  assert.equal(read.code, 0);
  assert.ok(!read.stdout.includes("\u001b"));
  assert.ok(!read.stderr.includes("\u001b"));
  assert.match(read.stdout, /red text/);
});

test("distinct message ids become distinct read blocks", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "many",
    "--env",
    "FAKE_MODE=messages",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const read = await harness.run(["read", spawned.value.session.id], {
    json: false,
  });
  assert.equal(read.code, 0);
  assert.equal(occurrences(read.stdout, "agent ›"), 2);
  assert.match(read.stdout, /first message/);
  assert.match(read.stdout, /second message/);
});
