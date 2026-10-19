import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Harness,
  type JsonError,
  type SpawnValue,
} from "./harness.js";

interface ListValue {
  sessions: {
    id: string;
    name: string | null;
    status: string;
    rootId: string;
    depth: number;
    cwd: string;
    lastActivityAt: string;
  }[];
}

async function settle(harness: Harness, args: string[], env?: Record<string, string>) {
  const result = await harness.json<SpawnValue>(args, env ? { env } : {});
  assert.equal(result.code, 0);
  return result.value.session;
}

test("list filters, sorts, and renders a wide or tree dashboard", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const alpha = await settle(harness, [
    "spawn",
    "fake",
    "alpha",
    "--name",
    "alpha",
    "--wait",
  ]);
  const beta = await settle(
    harness,
    ["spawn", "fake", "beta", "--name", "beta", "--wait"],
    { HLAO_SESSION_ID: alpha.id },
  );
  const gated = await settle(
    harness,
    [
      "spawn",
      "fake",
      "gated",
      "--name",
      "gated",
      "--env",
      "FAKE_MODE=permission",
      "--permission",
      "ask",
    ],
    { HLAO_SESSION_ID: alpha.id },
  );
  const gamma = await settle(harness, [
    "spawn",
    "fake",
    "gamma",
    "--name",
    "gamma",
    "--cwd",
    harness.home,
    "--wait",
  ]);

  const byName = await harness.json<ListValue>(["list", "--name", "beta"]);
  assert.deepEqual(byName.value.sessions.map((session) => session.id), [beta.id]);

  const byRoot = await harness.json<ListValue>(["list", "--root", "alpha"]);
  assert.deepEqual(
    new Set(byRoot.value.sessions.map((session) => session.id)),
    new Set([alpha.id, beta.id, gated.id]),
  );

  const pending = await harness.json<ListValue>(["list", "--pending"]);
  assert.deepEqual(
    pending.value.sessions.map((session) => session.id),
    [gated.id],
  );

  const byCwd = await harness.json<ListValue>([
    "list",
    "--cwd-prefix",
    harness.home,
  ]);
  assert.deepEqual(byCwd.value.sessions.map((session) => session.id), [gamma.id]);

  const idle = await harness.json<ListValue>(["list", "--status", "idle"]);
  assert.deepEqual(
    new Set(idle.value.sessions.map((session) => session.id)),
    new Set([alpha.id, beta.id, gamma.id]),
  );

  await settle(harness, ["send", gamma.id, "newest", "--wait"]);
  const activity = await harness.json<ListValue>([
    "list",
    "--sort",
    "activity",
  ]);
  assert.equal(activity.value.sessions[0]?.id, gamma.id);

  const wide = await harness.run(["list", "--wide", "--tree"], {
    json: false,
  });
  assert.equal(wide.code, 0);
  assert.match(wide.stdout, /BUSY/);
  assert.match(wide.stdout, /POLICY/);
  assert.match(wide.stdout, /PENDING/);
  assert.match(wide.stdout, /EXIT/);
  const lines = wide.stdout.split("\n");
  const alphaLine = lines.findIndex((line) => line.includes(alpha.id));
  const betaLine = lines.findIndex((line) => line.includes(beta.id));
  assert.ok(alphaLine >= 0 && betaLine > alphaLine);
  assert.match(lines[betaLine]!, /└ /);
});

test("list --watch streams JSON pages until killed", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  await settle(harness, ["spawn", "fake", "watched", "--name", "watched", "--wait"]);

  const child = spawn(
    process.execPath,
    [
      harness.cliEntry,
      "list",
      "--watch",
      "--interval",
      "250ms",
      "--home",
      harness.home,
      "--json",
    ],
    {
      env: { ...process.env, HLAO_HOME: harness.home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  t.after(() => child.kill("SIGKILL"));

  const line = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`no watch output\n${buffer}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(buffer.slice(0, newline));
      }
    });
    child.on("error", reject);
  });
  child.kill("SIGKILL");

  const page = JSON.parse(line) as ListValue;
  assert.ok(page.sessions.some((session) => session.name === "watched"));
});

test("bulk close selects, dry-runs, and forgets terminal sessions", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const one = await settle(harness, ["spawn", "fake", "one", "--name", "one", "--wait"]);
  const two = await settle(harness, ["spawn", "fake", "two", "--name", "two", "--wait"]);
  const busy = await settle(harness, [
    "spawn",
    "fake",
    "busy",
    "--env",
    "FAKE_MODE=slow-first",
    "--env",
    "FAKE_DELAY_MS=5000",
  ]);
  const crashed = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "crashed",
    "--env",
    "FAKE_MODE=crash",
  ]);
  assert.equal(crashed.code, 0);
  // Wait for the crash to settle.
  const died = await harness.json(["wait", crashed.value.session.id, "--until", "exit", "--timeout", "10s"]);
  assert.equal(died.code, 0);

  const dry = await harness.json<{
    dryRun: boolean;
    count: number;
    forgotten: number;
    sessions: { id: string }[];
  }>(["close", "--status", "idle", "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.equal(dry.value.dryRun, true);
  assert.equal(dry.value.count, 2);
  assert.deepEqual(
    new Set(dry.value.sessions.map((session) => session.id)),
    new Set([one.id, two.id]),
  );

  const closed = await harness.json<{ count: number; skipped: number }>([
    "close",
    "--status",
    "idle",
  ]);
  assert.equal(closed.code, 0);
  assert.equal(closed.value.count, 2);

  const forgotten = await harness.json<{ forgotten: number }>([
    "close",
    "--failed",
    "--forget",
  ]);
  assert.equal(forgotten.code, 0);
  assert.equal(forgotten.value.forgotten, 1);

  const all = await harness.json<ListValue>(["list", "--all"]);
  assert.ok(!all.value.sessions.some((session) => session.id === crashed.value.session.id));

  const liveForget = await harness.json<JsonError>([
    "close",
    busy.id,
    "--forget",
  ]);
  assert.equal(liveForget.code, 1);
  assert.equal(liveForget.value.error.code, "bad_request");

  const parent = await settle(harness, ["spawn", "fake", "parent", "--wait"]);
  const child = await settle(
    harness,
    ["spawn", "fake", "child", "--wait"],
    { HLAO_SESSION_ID: parent.id },
  );
  await harness.json(["close", parent.id]);
  await harness.json(["close", child.id]);

  const blocked = await harness.json<JsonError>(["close", parent.id, "--forget"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.value.error.message, /descendant/);

  const childForgotten = await harness.json<{ forgotten: boolean }>([
    "close",
    child.id,
    "--forget",
  ]);
  assert.equal(childForgotten.value.forgotten, true);
  const parentForgotten = await harness.json<{ forgotten: boolean }>([
    "close",
    parent.id,
    "--forget",
  ]);
  assert.equal(parentForgotten.value.forgotten, true);
});

test("read --out writes the JSON page without changing normal output", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await settle(harness, ["spawn", "fake", "export", "--wait"]);
  const directory = mkdtempSync(join(tmpdir(), "hlao-export-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "page.json");

  const json = await harness.run(
    ["read", spawned.id, "--since", "0", "--out", file],
    { json: true },
  );
  assert.equal(json.code, 0);
  assert.ok(existsSync(file));
  assert.deepEqual(
    JSON.parse(readFileSync(file, "utf8")),
    JSON.parse(json.stdout),
  );

  const humanFile = join(directory, "page-human.json");
  const human = await harness.run(
    ["read", spawned.id, "--since", "0", "--out", humanFile],
    { json: false },
  );
  assert.equal(human.code, 0);
  assert.match(human.stdout, /saved /);
  assert.ok(existsSync(humanFile));

  const conflict = await harness.json<JsonError>([
    "read",
    spawned.id,
    "--follow",
    "--out",
    join(directory, "no.json"),
  ]);
  assert.equal(conflict.code, 1);
  assert.equal(conflict.value.error.code, "bad_request");
});
