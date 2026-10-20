import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLI_ENTRY, Harness, type SpawnValue } from "./harness.js";

test("export pages the full history instead of one bounded page", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(
    [
      "spawn",
      "fake",
      "flood",
      "--env",
      "FAKE_MODE=flood",
      "--env",
      "FAKE_CHUNKS=1200",
      "--wait",
    ],
    { timeoutMs: 120_000 },
  );
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const directory = mkdtempSync(join(tmpdir(), "hlao-export-full-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "history.json");

  const result = await harness.run(["export", id, "--out", file], {
    json: false,
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /exported \d+ events/);

  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    count: number;
    truncated: boolean;
    lastSeq: number;
    events: { seq: number }[];
  };
  assert.ok(
    parsed.count > 1_000,
    `expected more than one page, exported ${parsed.count}`,
  );
  assert.equal(parsed.events.length, parsed.count);
  assert.equal(parsed.lastSeq, parsed.events[parsed.events.length - 1]?.seq);

  const seqs = parsed.events.map((event) => event.seq);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
});

test("a reader that closes the pipe early is not an EPIPE crash", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(
    [
      "spawn",
      "fake",
      "flood",
      "--env",
      "FAKE_MODE=flood",
      "--env",
      "FAKE_CHUNKS=1200",
      "--wait",
    ],
    { timeoutMs: 120_000 },
  );
  assert.equal(spawned.code, 0);
  const id = spawned.value.session.id;

  const env: NodeJS.ProcessEnv = { ...process.env, HLAO_HOME: harness.home, NO_COLOR: "1" };
  for (const key of ["HLAO_SESSION_ID", "HLAO_PARENT_ID", "HLAO_ROOT_ID"]) delete env[key];
  const argv = [
    CLI_ENTRY,
    "read",
    id,
    "--since",
    "0",
    "--limit",
    "1000",
    "--jsonl",
    "--home",
    harness.home,
  ];

  const result = await new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, argv, {
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`EPIPE test timed out\n${stderr}`));
      }, 60_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      // Close our end before any output exists, like `| head -n 0`. The child
      // must treat the broken pipe as a normal end, not an unhandled error.
      child.stdout.on("error", () => {
        // The parent's own stream error is irrelevant to the assertion.
      });
      child.stdout.destroy();
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /EPIPE|Unhandled 'error' event/);
});
