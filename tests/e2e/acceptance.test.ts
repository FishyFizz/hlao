import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Harness, type RunResult } from "./harness.js";

const EXAMPLES = fileURLToPath(
  new URL("../../../examples/acceptance/", import.meta.url),
);

function runExample(
  harness: Harness,
  script: string,
  args: string[],
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HLAO_HOME: harness.home,
    HLAO_CLI: harness.cliEntry,
    NO_COLOR: "1",
  };
  for (const key of [
    "HLAO_SESSION_ID",
    "HLAO_PARENT_ID",
    "HLAO_ROOT_ID",
    "HLAO_DEPTH",
    "HLAO_BACKEND",
  ]) {
    delete env[key];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(EXAMPLES, script), ...args], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script} timed out\n${stderr}`));
    }, 120_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("acceptance: cron is assembled from a loop and one-shot waits", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const counterFile = join(harness.home, "counter.json");

  const result = await runExample(harness, "cron.mjs", [
    "--backend",
    "fake",
    "--interval",
    "100ms",
    "--max-checks",
    "5",
    "--env",
    "FAKE_MODE=counter",
    "--env",
    `FAKE_COUNTER_FILE=${counterFile}`,
    "--env",
    "FAKE_DONE_AT=3",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /STATUS: RUNNING count=1/);
  assert.match(result.stdout, /STATUS: RUNNING count=2/);
  assert.match(result.stdout, /STATUS: DONE/);
  assert.match(result.stdout, /done after 3 checks/);
  assert.equal(JSON.parse(readFileSync(counterFile, "utf8")).count, 3);
});

test("acceptance: delegation spawns, waits, reads, integrates, closes", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const result = await runExample(harness, "delegation.mjs", [
    "--backend",
    "fake",
    "--task",
    "summarize the log",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /worker [0-9a-z]{6}/);
  assert.match(result.stdout, /integrated result: echo:/);
  assert.match(result.stdout, /closed [0-9a-z]{6}/);

  const sessions = await harness.json<{ sessions: { status: string }[] }>(["list"]);
  assert.ok(sessions.value.sessions.every((session) => session.status !== "busy"));
});

test("acceptance: delegation integrates a turn larger than one read page", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const result = await runExample(harness, "delegation.mjs", [
    "--backend",
    "fake",
    "--env",
    "FAKE_MODE=flood",
    "--env",
    "FAKE_CHUNKS=140",
    "--task",
    "produce a large transcript",
  ]);

  assert.equal(result.code, 0, result.stderr);
  // The worker's turn text is used directly, so the last chunk cannot fall
  // outside a 100-event page.
  assert.match(result.stdout, /chunk-139/);
});

test("acceptance: kanban is a ledger file plus messages, not an object", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());
  const ledger = join(harness.home, "board.md");

  const result = await runExample(harness, "kanban.mjs", [
    "--backend",
    "fake",
    "--ledger",
    ledger,
    "--tasks",
    "audit the build,summarize the failure",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(ledger));
  const board = readFileSync(ledger, "utf8");
  assert.match(board, /- \[audit the build\]/);
  assert.match(board, /- \[summarize the failure\]/);
  assert.match(result.stdout, /card done: audit the build/);
});

test("acceptance: dynamic workflow lets a finding stop the plan", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const result = await runExample(harness, "workflow.mjs", [
    "--backend",
    "fake",
    "--goal",
    "migrate the build to the new runner",
    "--env",
    "FAKE_MODE=verdict",
    "--env",
    "FAKE_VERDICT=impossible",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /VERDICT: impossible/);
  assert.match(result.stdout, /the plan stops here/);

  const sessions = await harness.json<{ sessions: unknown[] }>(["list"]);
  assert.equal(sessions.value.sessions.length, 0);
});

test("acceptance: dynamic workflow spawns the next step only when allowed", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const result = await runExample(harness, "workflow.mjs", [
    "--backend",
    "fake",
    "--goal",
    "migrate the build to the new runner",
    "--env",
    "FAKE_MODE=verdict",
    "--env",
    "FAKE_VERDICT=possible",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /VERDICT: possible/);
  assert.match(result.stdout, /worker [0-9a-z]{6}/);
  assert.match(result.stdout, /workflow complete/);
});
