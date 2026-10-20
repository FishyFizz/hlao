import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Harness, type DoctorValue } from "./harness.js";

test("doctor keeps its JSON shape when project config is invalid", async (t) => {
  const harness = new Harness();
  const project = mkdtempSync(join(tmpdir(), "hlao-doctor-project-"));
  t.after(async () => {
    await harness.cleanup();
    rmSync(project, { recursive: true, force: true });
  });

  mkdirSync(join(project, ".hlao"));
  writeFileSync(
    join(project, ".hlao", "agents.json"),
    JSON.stringify({ backends: { broken: { args: [] } } }),
  );

  const doctor = await harness.json<DoctorValue>(["doctor"], { cwd: project });
  assert.equal(doctor.code, 1);
  assert.equal(doctor.value.ok, false);
  const backends = doctor.value.checks.find((check) => check.name === "backends");
  assert.equal(backends?.status, "fail");
  assert.match(backends?.detail ?? "", /agents\.json|command/i);
});
