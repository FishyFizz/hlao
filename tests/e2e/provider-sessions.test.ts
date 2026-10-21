import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type {
  ProviderSessionsResult,
  ReadResult,
  SpawnResult,
} from "../../src/protocol.js";
import { Harness, type JsonError, type ListValue } from "./harness.js";

function enableProviderCatalog(
  harness: Harness,
  rows: Array<{
    sessionId: string;
    cwd: string;
    title?: string;
    updatedAt?: string;
  }>,
  extra: Record<string, string> = {},
): void {
  const catalog = join(harness.home, "provider-catalog.jsonl");
  harness.updateConfig((config) => {
    const backends = config.backends as Record<
      string,
      { env?: Record<string, string> }
    >;
    backends.fake!.env = {
      ...(backends.fake!.env ?? {}),
      FAKE_LOAD_SESSION: "1",
      FAKE_PROVIDER_CATALOG_FILE: catalog,
      FAKE_PROVIDER_SESSIONS: JSON.stringify(rows),
      ...extra,
    };
  });
}

test("provider sessions reads the provider catalog and joins the live table", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const cwd = process.cwd();
  const other = join(harness.home, "other-cwd");
  mkdirSync(other, { recursive: true });
  enableProviderCatalog(harness, [
    {
      sessionId: "fake-external-1",
      cwd,
      title: "External work",
      updatedAt: new Date().toISOString(),
    },
    {
      sessionId: "fake-external-other",
      cwd: other,
      title: "Elsewhere",
      updatedAt: new Date().toISOString(),
    },
  ]);

  const spawned = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "--cwd",
    cwd,
    "--name",
    "builder",
    "--no-skill",
  ]);
  assert.equal(spawned.code, 0);
  assert.equal(spawned.value.session.agentSessionId, "fake-1");

  const scoped = await harness.json<ProviderSessionsResult>([
    "provider",
    "sessions",
    "fake",
    "--cwd",
    cwd,
  ]);
  assert.equal(scoped.code, 0);
  assert.equal(scoped.value.backend, "fake");
  assert.equal(scoped.value.cwd, cwd);
  assert.equal(scoped.value.agentName, "fake-acp");
  assert.equal(scoped.value.sessions.length, 2, "cwd filter excludes the other row");
  const own = scoped.value.sessions.find((row) => row.sessionId === "fake-1");
  assert.ok(own, "the spawned provider session is listed");
  assert.equal(own!.attached, true);
  assert.equal(own!.hlaoSessionId, spawned.value.session.id);
  assert.equal(own!.hlaoName, "builder");
  assert.equal(own!.hlaoStatus, "idle");
  assert.equal(own!.loadable, true);
  assert.equal(own!.forkable, false);
  const external = scoped.value.sessions.find(
    (row) => row.sessionId === "fake-external-1",
  );
  assert.ok(external);
  assert.equal(external!.attached, false);
  assert.equal(external!.title, "External work");
  assert.equal(external!.hlaoSessionId, null);

  const all = await harness.json<ProviderSessionsResult>([
    "provider",
    "sessions",
    "fake",
    "--all",
  ]);
  assert.equal(all.code, 0);
  assert.equal(all.value.cwd, null);
  assert.equal(all.value.sessions.length, 3);
  assert.ok(
    all.value.sessions.some((row) => row.sessionId === "fake-external-other"),
  );

  // The catalog read starts an adapter but creates no HLAO session.
  const listed = await harness.json<ListValue>(["list", "--all"]);
  assert.equal(listed.code, 0);
  assert.equal(listed.value.sessions.length, 1);
});

test("adopt takes a provider session into the instance and uses its cwd", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const cwd = process.cwd();
  enableProviderCatalog(harness, [
    {
      sessionId: "fake-external-1",
      cwd,
      title: "External work",
      updatedAt: new Date().toISOString(),
    },
    {
      sessionId: "fake-external-2",
      cwd,
      title: "Second external work",
      updatedAt: new Date().toISOString(),
    },
  ]);

  const adopted = await harness.json<SpawnResult>([
    "adopt",
    "fake",
    "fake-external-1",
    "--name",
    "recovered",
    "--no-skill",
  ]);
  assert.equal(adopted.code, 0);
  assert.equal(adopted.value.resumed, true);
  assert.equal(adopted.value.session.agentSessionId, "fake-external-1");
  assert.equal(adopted.value.session.cwd, cwd);
  assert.equal(adopted.value.session.name, "recovered");
  assert.equal(adopted.value.session.parentId, null, "an operator adoption is a root");

  const read = await harness.json<ReadResult>([
    "read",
    adopted.value.session.id,
    "--since",
    "0",
  ]);
  assert.equal(read.code, 0);
  assert.ok(
    read.value.events.some((event) => event.type === "session.resumed"),
    "adoption emits session.resumed",
  );
  assert.ok(
    read.value.events.some((event) => event.replay === true),
    "the provider history is replayed",
  );

  // A second adoption of the same provider id returns the live session.
  const again = await harness.json<SpawnResult>([
    "adopt",
    "fake",
    "fake-external-1",
    "--no-skill",
  ]);
  assert.equal(again.code, 0);
  assert.equal(again.value.duplicate, true);
  assert.equal(again.value.session.id, adopted.value.session.id);

  // An operator can place the adopted agent under an existing live session.
  const parent = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "--cwd",
    cwd,
    "--name",
    "parent",
    "--no-skill",
  ]);
  assert.equal(parent.code, 0);
  const child = await harness.json<SpawnResult>([
    "adopt",
    "fake",
    "fake-external-2",
    "--parent",
    parent.value.session.id,
    "--name",
    "child",
    "--no-skill",
  ]);
  assert.equal(child.code, 0);
  assert.equal(child.value.session.parentId, parent.value.session.id);
  assert.equal(child.value.session.rootId, parent.value.session.id);
  assert.equal(child.value.session.depth, 1);
});

test("adopt refuses a cwd that disagrees with the provider catalog", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const cwd = process.cwd();
  const other = join(harness.home, "other-cwd");
  mkdirSync(other, { recursive: true });
  enableProviderCatalog(harness, [
    { sessionId: "fake-external-1", cwd, title: "External work" },
  ]);

  const failed = await harness.json<JsonError>([
    "adopt",
    "fake",
    "fake-external-1",
    "--cwd",
    other,
  ]);
  assert.equal(failed.code, 1);
  assert.equal(failed.value.ok, false);
  assert.equal(failed.value.error.code, "bad_request");
  assert.match(failed.value.error.message, /belongs to/);
});

test("provider sessions fails clearly when the adapter has no session/list", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  enableProviderCatalog(harness, [], { FAKE_NO_LIST_SESSION: "1" });

  const failed = await harness.json<JsonError>([
    "provider",
    "sessions",
    "fake",
    "--cwd",
    process.cwd(),
  ]);
  assert.equal(failed.code, 1);
  assert.equal(failed.value.ok, false);
  assert.equal(failed.value.error.code, "bad_request");
  assert.match(failed.value.error.message, /does not advertise ACP session\/list/);
});

test("adopt --fork copies the provider session and leaves the source alone", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const cwd = process.cwd();
  enableProviderCatalog(
    harness,
    [{ sessionId: "fake-external-1", cwd, title: "External work" }],
    { FAKE_FORK_SESSION: "1" },
  );

  const forked = await harness.json<SpawnResult>([
    "adopt",
    "fake",
    "fake-external-1",
    "--fork",
    "--no-skill",
  ]);
  assert.equal(forked.code, 0);
  assert.equal(forked.value.forked, true);
  assert.equal(forked.value.session.agentSessionId, "fake-external-1-fork-1");
  assert.equal(forked.value.session.forkedFrom, "fake-external-1");
  assert.equal(forked.value.session.cwd, cwd);
});

test("a resume keeps the provider's mode instead of applying backend defaultMode", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const cwd = process.cwd();
  const catalog = join(harness.home, "provider-catalog.jsonl");
  harness.updateConfig((config) => {
    const backends = config.backends as Record<
      string,
      { env?: Record<string, string>; defaultMode?: string }
    >;
    backends.fake!.defaultMode = "auto";
    backends.fake!.env = {
      ...(backends.fake!.env ?? {}),
      FAKE_LOAD_SESSION: "1",
      FAKE_PROVIDER_CATALOG_FILE: catalog,
    };
  });

  const first = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "--cwd",
    cwd,
    "--mode",
    "default",
    "--no-skill",
  ]);
  assert.equal(first.code, 0);
  assert.equal(first.value.session.modes?.currentModeId, "default");
  const providerId = first.value.session.agentSessionId;
  assert.ok(providerId);

  await harness.run(["down", "--force"], { timeoutMs: 15_000 });

  const resumed = await harness.json<SpawnResult>([
    "spawn",
    "fake",
    "--resume",
    providerId!,
    "--cwd",
    cwd,
    "--no-skill",
  ]);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.value.session.modes?.currentModeId, "default");
});
