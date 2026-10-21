import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { CLI_ENTRY, Harness, waitFor, type SpawnValue } from "./harness.js";

interface WatchLine {
  kind: string;
  sessionId?: string;
  session?: { id: string };
  event?: { seq: number; type: string };
  sessions?: number;
}

function startWatch(
  harness: Harness,
  args: string[],
  options: { json?: boolean } = {},
): {
  child: ReturnType<typeof spawn>;
  lines: WatchLine[];
  stderr: () => string;
  stop: () => Promise<void>;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HLAO_HOME: harness.home,
    NO_COLOR: "1",
  };
  for (const key of ["HLAO_SESSION_ID", "HLAO_PARENT_ID", "HLAO_ROOT_ID"]) {
    delete env[key];
  }
  const argv = [CLI_ENTRY, "watch", ...args, "--home", harness.home];
  if (options.json !== false) argv.push("--json");
  const child = spawn(process.execPath, argv, {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: WatchLine[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) lines.push(JSON.parse(line) as WatchLine);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    lines,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

test("watch follows a session created after it starts", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const watch = startWatch(harness, []);
  t.after(async () => {
    await watch.stop();
  });

  await waitFor(
    () => watch.lines.some((line) => line.kind === "watch.started"),
    "watch to subscribe",
    20_000,
  );

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "watched", "--wait"]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  await waitFor(
    () => watch.lines.some((line) => line.kind === "session.joined" && line.sessionId === id),
    `watch to join ${id}`,
    20_000,
  );
  await waitFor(
    () =>
      watch.lines.some(
        (line) => line.kind === "event" && line.sessionId === id,
      ),
    `watch to receive an event for ${id}`,
    20_000,
  );

  const events = watch.lines.filter(
    (line) => line.kind === "event" && line.sessionId === id,
  );
  assert.ok(events.some((line) => line.event?.type === "prompt.sent"));
  assert.ok(events.some((line) => line.event?.type === "turn.started"));
  assert.ok(
    events.every(
      (line, index) =>
        index === 0 || line.event!.seq > events[index - 1]!.event!.seq,
    ),
    `events must be ordered; stderr: ${watch.stderr()}`,
  );
});

test("watch reports a reconnect and follows a restarted supervisor", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const watch = startWatch(harness, []);
  t.after(async () => {
    await watch.stop();
  });

  await waitFor(
    () => watch.lines.some((line) => line.kind === "watch.started"),
    "watch to subscribe",
    20_000,
  );

  const before = await harness.json<SpawnValue>(["spawn", "fake", "before restart", "--wait"]);
  assert.equal(before.code, 0);
  const beforeId = before.value.session.id;
  await waitFor(
    () => watch.lines.some((line) => line.kind === "event" && line.sessionId === beforeId),
    `watch to receive an event for ${beforeId}`,
    20_000,
  );

  const down = await harness.run(["down", "--force"], { timeoutMs: 20_000 });
  assert.equal(down.code, 0);

  await waitFor(
    () => watch.stderr().includes("reconnecting"),
    "a reconnect notice on stderr",
    20_000,
  );
  await waitFor(
    () => watch.lines.filter((line) => line.kind === "watch.started").length >= 2,
    "a second watch.started after the restart",
    20_000,
  );

  const after = await harness.json<SpawnValue>(["spawn", "fake", "after restart", "--wait"]);
  assert.equal(after.code, 0);
  const afterId = after.value.session.id;
  await waitFor(
    () => watch.lines.some((line) => line.kind === "event" && line.sessionId === afterId),
    `watch to follow the post-restart session ${afterId}`,
    20_000,
  );
});

test("watch --root exits when the root is gone instead of retrying forever", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "gone", "--wait"]);
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const down = await harness.run(["down", "--force"], { timeoutMs: 20_000 });
  assert.equal(down.code, 0);

  // Human mode: the fatal selector error is reported on stderr. (JSON mode
  // emits the envelope on stdout, which is not NDJSON.)
  const watch = startWatch(harness, ["--root", id], { json: false });
  t.after(async () => {
    await watch.stop();
  });

  await waitFor(() => watch.child.exitCode !== null, "watch to exit", 20_000);
  assert.equal(watch.child.exitCode, 1);
  assert.match(watch.stderr(), /no session matching/);
});

test("watch --root scopes the merged timeline", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const scoped = await harness.json<SpawnValue>(["spawn", "fake", "scoped", "--wait"]);
  const other = await harness.json<SpawnValue>(["spawn", "fake", "other", "--wait"]);
  assert.equal(scoped.code, 0);
  assert.equal(other.code, 0);
  const scopedId = scoped.value.session.id;
  const otherId = other.value.session.id;

  const watch = startWatch(harness, ["--root", scopedId]);
  t.after(async () => {
    await watch.stop();
  });

  await waitFor(
    () => watch.lines.some((line) => line.kind === "watch.started"),
    "watch to subscribe",
    20_000,
  );

  await harness.json(["send", scopedId, "scoped follow-up"]);
  await harness.json(["send", otherId, "other follow-up"]);

  await waitFor(
    () =>
      watch.lines.some(
        (line) => line.kind === "event" && line.sessionId === scopedId,
      ),
    "watch to see the scoped session",
    20_000,
  );
  assert.equal(
    watch.lines.some(
      (line) => line.kind === "event" && line.sessionId === otherId,
    ),
    false,
    "a session outside --root must not appear",
  );
});
