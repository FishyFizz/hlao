import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Harness, type SpawnValue } from "./harness.js";

interface ManifestValue {
  failures: number;
  sessions: {
    sessionId: string;
    file: string;
    count: number;
    truncated: boolean;
    error?: string;
  }[];
}

test("export --all writes one file per session plus a manifest", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const first = await harness.json<SpawnValue>(["spawn", "fake", "one", "--wait"]);
  const second = await harness.json<SpawnValue>(["spawn", "fake", "two", "--wait"]);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);

  const directory = mkdtempSync(join(tmpdir(), "hlao-export-all-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const exported = await harness.run(["export", "--all", "--out", directory], {
    json: false,
    timeoutMs: 60_000,
  });
  assert.equal(exported.code, 0);
  assert.match(exported.stdout, /exported 2 of 2 sessions/);

  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  ) as ManifestValue;
  assert.equal(manifest.failures, 0);
  assert.equal(manifest.sessions.length, 2);
  for (const entry of manifest.sessions) {
    assert.equal(entry.error, undefined);
    assert.ok(entry.count > 0);
    const file = join(directory, entry.file);
    assert.ok(existsSync(file), file);
    const payload = JSON.parse(readFileSync(file, "utf8")) as {
      events: { seq: number }[];
    };
    assert.equal(payload.events.length, entry.count);
  }

  const again = await harness.run(["export", "--all", "--out", directory]);
  assert.equal(again.code, 1);
  assert.match(again.stdout, /refusing to overwrite/);
});

test("down --export exports everything before stopping", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "keep", "--wait"]);
  assert.equal(spawned.code, 0);

  const directory = mkdtempSync(join(tmpdir(), "hlao-down-export-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const result = await harness.run(["down", "--export", directory], {
    json: true,
    timeoutMs: 60_000,
  });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout) as {
    stopped: boolean;
    exported: number;
    exportDir: string;
  };
  assert.equal(payload.stopped, true);
  assert.equal(payload.exported, 1);
  assert.equal(payload.exportDir, directory);

  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  ) as ManifestValue;
  assert.equal(manifest.failures, 0);
  assert.equal(manifest.sessions.length, 1);
  assert.ok(existsSync(join(directory, manifest.sessions[0]!.file)));
});

test("down --dry-run --export reports without writing", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const spawned = await harness.json<SpawnValue>(["spawn", "fake", "dry", "--wait"]);
  assert.equal(spawned.code, 0);

  const directory = join(
    mkdtempSync(join(tmpdir(), "hlao-down-export-dry-")),
    "not-created",
  );
  t.after(() => rmSync(join(directory, ".."), { recursive: true, force: true }));

  const result = await harness.run(
    ["down", "--dry-run", "--export", directory],
    { json: true },
  );
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout) as {
    dryRun: boolean;
    exportCount: number;
  };
  assert.equal(payload.dryRun, true);
  assert.equal(payload.exportCount, 1);
  assert.equal(existsSync(directory), false);
});
