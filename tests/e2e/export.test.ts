import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Harness, type SpawnValue } from "./harness.js";

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
