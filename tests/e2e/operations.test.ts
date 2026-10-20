import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readLock } from "../../src/lock.js";
import {
  FAKE_AGENT,
  Harness,
  type DoctorValue,
  type JsonError,
  type ReadValue,
  type SpawnValue,
} from "./harness.js";

test("agents and doctor inspect configuration without starting a supervisor", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const agents = await harness.json<{
    agents: { name: string; available: boolean }[];
  }>(["agents"]);
  assert.equal(agents.code, 0);
  assert.ok(agents.value.agents.some((agent) => agent.name === "fake"));
  assert.equal(readLock(harness.home), null);

  const doctor = await harness.json<DoctorValue>(["doctor"]);
  assert.equal(doctor.code, 0);
  assert.equal(doctor.value.ok, true);
  const supervisor = doctor.value.checks.find(
    (check) => check.name === "supervisor",
  );
  assert.equal(supervisor?.status, "warn");
  assert.match(supervisor?.detail ?? "", /not running/);
  const log = doctor.value.checks.find((check) => check.name === "log");
  assert.equal(log?.status, "warn");
  assert.match(log?.detail ?? "", /supervisor\.log/);
  const backends = doctor.value.checks.find(
    (check) => check.name === "backends",
  );
  assert.match(backends?.detail ?? "", /adapter command.* present/);
  assert.equal(readLock(harness.home), null);

  const started = await harness.json<DoctorValue>(["doctor", "--start"]);
  assert.equal(started.code, 0);
  assert.equal(
    started.value.checks.find((check) => check.name === "supervisor")?.status,
    "ok",
  );
  assert.notEqual(readLock(harness.home), null);

  const probed = await harness.json<DoctorValue>(["doctor", "--probe"]);
  assert.equal(probed.code, 0);
  assert.equal(
    probed.value.checks.find((check) => check.name === "probe fake")?.status,
    "ok",
  );
});

test("status probes without autostart and --start launches the supervisor", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const stopped = await harness.json<{ running: boolean }>(["status"]);
  assert.equal(stopped.code, 1);
  assert.equal(stopped.value.running, false);
  assert.equal(readLock(harness.home), null);

  const started = await harness.json<{
    running: boolean;
    pid: number;
    sessions: number;
  }>(["status", "--start"]);
  assert.equal(started.code, 0);
  assert.equal(started.value.running, true);
  assert.equal(typeof started.value.pid, "number");
  assert.equal(started.value.sessions, 0);

  const running = await harness.json<{ running: boolean }>(["status"]);
  assert.equal(running.code, 0);
  assert.equal(running.value.running, true);
});

test("logs reads the supervisor log directly", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const empty = await harness.json<{ path: string; lines: string[] }>(["logs"]);
  assert.equal(empty.code, 0);
  assert.deepEqual(empty.value.lines, []);

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "logged",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const logs = await harness.json<{ path: string; lines: string[] }>([
    "logs",
    "--lines",
    "200",
  ]);
  assert.equal(logs.code, 0);
  assert.ok(logs.value.lines.some((line) => line.includes("spawned")));
  assert.ok(logs.value.path.endsWith("supervisor.log"));
});

test("config can be inspected locally and validates", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  harness.updateConfig((config) => {
    const backends = config.backends as Record<
      string,
      Record<string, unknown>
    >;
    backends.fake!.env = { SECRET_TOKEN: "super-secret" };
  });

  const path = await harness.json<{ path: string }>(["config", "path"]);
  assert.equal(path.code, 0);
  assert.equal(resolve(path.value.path), resolve(join(harness.home, "config.json")));

  const show = await harness.json<{
    config: { backends: Record<string, { env: Record<string, string> }> };
    error: null;
  }>(["config", "show"]);
  assert.equal(show.code, 0);
  assert.equal(show.value.config.backends.fake!.env.SECRET_TOKEN, "***");
  assert.ok(!JSON.stringify(show.value).includes("super-secret"));

  const valid = await harness.json<{ ok: boolean }>(["config", "validate"]);
  assert.equal(valid.code, 0);
  assert.equal(valid.value.ok, true);

  writeFileSync(
    join(harness.home, "config.json"),
    JSON.stringify({ nonsense: true }),
  );

  const invalid = await harness.json<JsonError>(["config", "validate"]);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.value.error.code, "config_invalid");

  const shown = await harness.json<{
    error: { code: string } | null;
    config: { permissionPolicy: string };
  }>(["config", "show"]);
  assert.equal(shown.code, 0);
  assert.equal(shown.value.error?.code, "config_invalid");
  assert.equal(shown.value.config.permissionPolicy, "allow");

  const agents = await harness.json<JsonError>(["agents"]);
  assert.equal(agents.code, 1);
  assert.equal(agents.value.error.code, "config_invalid");
});

test("reload applies new config only to new spawns and is operator-only", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const first = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "first",
    "--wait",
  ]);
  assert.equal(first.code, 0);
  assert.equal(first.value.session.permissionPolicy, "allow");
  const firstId = first.value.session.id;

  harness.updateConfig((config) => {
    config.permissionPolicy = "ask";
  });

  const reload = await harness.json<{
    configHash: string;
    configError: string | null;
  }>(["reload"]);
  assert.equal(reload.code, 0);
  assert.equal(reload.value.configError, null);
  assert.match(reload.value.configHash, /^[0-9a-f]{64}$/);

  const second = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "second",
    "--wait",
  ]);
  assert.equal(second.code, 0);
  assert.equal(second.value.session.permissionPolicy, "ask");

  const live = await harness.json<ReadValue>(["read", firstId]);
  assert.equal(live.value.session.permissionPolicy, "allow");

  const denied = await harness.json<JsonError>(["reload"], {
    env: { HLAO_SESSION_ID: firstId },
  });
  assert.equal(denied.code, 1);
  assert.equal(denied.value.error.code, "operator_only");
});

test("an invalid reload blocks new spawns until the file is fixed", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const started = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "start",
    "--wait",
  ]);
  assert.equal(started.code, 0);

  writeFileSync(
    join(harness.home, "config.json"),
    JSON.stringify({ permissionPolicy: "sometimes" }),
  );
  const failed = await harness.json<JsonError>(["reload"]);
  assert.equal(failed.code, 1);
  assert.equal(failed.value.error.code, "config_invalid");
  assert.match(failed.value.error.message, /permissionPolicy/);

  const blocked = await harness.json<JsonError>(["spawn", "fake"]);
  assert.equal(blocked.code, 1);
  assert.equal(blocked.value.error.code, "config_invalid");

  const doctor = await harness.json<DoctorValue>(["doctor"]);
  assert.equal(doctor.code, 1);
  assert.equal(
    doctor.value.checks.find((check) => check.name === "config load")?.status,
    "fail",
  );

  writeFileSync(
    join(harness.home, "config.json"),
    JSON.stringify(
      {
        permissionPolicy: "allow",
        backends: {
          fake: {
            command: process.execPath,
            args: [FAKE_AGENT],
            description: "scripted ACP test agent",
          },
        },
      },
      null,
      2,
    ),
  );
  const fixed = await harness.json<{ configError: string | null }>(["reload"]);
  assert.equal(fixed.code, 0);
  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "again",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);
});

test("read --follow emits JSON pages and stops when the session dies", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "follow",
    "--env",
    "FAKE_MODE=delayed-crash",
    "--env",
    "FAKE_DELAY_MS=400",
  ]);
  assert.equal(spawned.code, 0);

  const follow = await harness.run(
    ["read", spawned.value.session.id, "--follow", "--since", "0"],
    { timeoutMs: 20_000 },
  );
  assert.equal(follow.code, 0);
  const pages = follow.stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          session: { status: string };
          events: unknown[];
        },
    );
  assert.ok(pages.length >= 1);
  for (const page of pages) {
    assert.ok(Array.isArray(page.events));
    assert.equal(typeof page.session.status, "string");
  }
  assert.equal(pages.at(-1)?.session.status, "failed");
});

test("spawn --wait prints the handle before the first turn finishes", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const child = spawn(
    process.execPath,
    [
      harness.cliEntry,
      "spawn",
      "fake",
      "slow first turn",
      "--env",
      "FAKE_MODE=slow",
      "--env",
      "FAKE_DELAY_MS=5000",
      "--wait",
      "--timeout",
      "15s",
      "--home",
      harness.home,
      "--no-color",
    ],
    {
      env: { ...process.env, HLAO_HOME: harness.home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let stdout = "";
  let stderr = "";
  let settled = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<number | null>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      settled = true;
      resolvePromise(code);
    });
  });

  try {
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `handle was not printed before the turn ended\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }, 3_500);
      const check = (): void => {
        if (/spawned /.test(stdout) && !/turn 1 ended/.test(stdout)) {
          clearTimeout(timer);
          resolvePromise();
        }
      };
      child.stdout.on("data", check);
      check();
    });

    const code = await exited;
    assert.equal(code, 0);
    assert.match(stdout, /spawned /);
    assert.match(stdout, /— turn 1 ended: end_turn —/);
    assert.match(stdout, /stopped: end_turn/);
  } finally {
    if (!settled) child.kill("SIGKILL");
  }
});

test("help and version honor --json", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const help = await harness.json<{ topic: string | null; help: string }>([
    "help",
    "spawn",
  ]);
  assert.equal(help.value.topic, "spawn");
  assert.match(help.value.help, /hlao spawn <backend>/);

  const full = await harness.json<{ topic: null; help: string }>(["help"]);
  assert.equal(full.value.topic, null);
  assert.match(full.value.help, /Usage:/);

  const commandHelp = await harness.json<{ topic: string; help: string }>([
    "spawn",
    "--help",
  ]);
  assert.equal(commandHelp.value.topic, "spawn");

  const version = await harness.json<{ version: string }>(["version"]);
  assert.match(version.value.version, /^\d+\.\d+\.\d+/);
});

test("a spawn failure carries the adapter exit code", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const failed = await harness.json<JsonError>([
    "spawn",
    "fake",
    "crash",
    "--env",
    "FAKE_MODE=crash-start",
  ]);
  assert.equal(failed.code, 1);
  assert.equal(failed.value.error.code, "spawn_failed");
  const details = failed.value.error.details as {
    exit?: { code: number | null; signal: string | null };
  };
  assert.equal(details.exit?.code, 3);

  const human = await harness.run(
    ["spawn", "fake", "crash", "--env", "FAKE_MODE=crash-start"],
    { json: false },
  );
  assert.equal(human.code, 1);
  assert.match(human.stderr, /adapter exit: code 3/);
});

test("session.created records the name, requested mode, and env keys", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "recorded",
    "--name",
    "recorded-label",
    "--mode",
    "auto",
    "--env",
    "SECRET_TOKEN=super-secret-value",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const read = await harness.run(
    ["read", spawned.value.session.id, "--since", "0", "--json"],
    { json: true },
  );
  assert.equal(read.code, 0);
  assert.ok(!read.stdout.includes("super-secret-value"));
  const page = JSON.parse(read.stdout) as ReadValue;
  const created = page.events.find((event) => event.type === "session.created");
  assert.ok(created);
  assert.equal(created.data.name, "recorded-label");
  assert.equal(created.data.mode, "auto");
  assert.deepEqual(created.data.envKeys, ["SECRET_TOKEN"]);
});

test("a version mismatch warns once without blocking the command", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>([
    "spawn",
    "fake",
    "version",
    "--wait",
  ]);
  assert.equal(spawned.code, 0);

  const lockFile = join(harness.home, "supervisor.json");
  const lock = JSON.parse(readFileSync(lockFile, "utf8")) as Record<string, unknown>;
  lock.version = "0.0.0";
  writeFileSync(lockFile, JSON.stringify(lock, null, 2));

  const listed = await harness.run(["list", "--json"], { json: true });
  assert.equal(listed.code, 0);
  assert.match(
    listed.stderr,
    /supervisor 0\.0\.0 differs from CLI \d+\.\d+\.\d+/,
  );
  assert.equal(listed.stderr.match(/differs from CLI/g)?.length, 1);
});
