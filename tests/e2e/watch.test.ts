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
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "watch", ...args, "--json", "--home", harness.home],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
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
