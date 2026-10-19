import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Harness, type JsonError, type ListValue } from "./harness.js";

interface DoctorValue {
  ok: boolean;
  checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[];
}

test("invalid user config blocks backend requests but leaves the supervisor usable", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  writeFileSync(
    join(harness.home, "config.json"),
    JSON.stringify({ permissionPolicy: "allow", waitTime: 1000 }),
  );

  const spawned = await harness.json<JsonError>(["spawn", "fake"]);
  assert.equal(spawned.code, 1);
  assert.equal(spawned.value.error.code, "config_invalid");

  const agents = await harness.json<JsonError>(["agents"]);
  assert.equal(agents.code, 1);
  assert.equal(agents.value.error.code, "config_invalid");

  // The supervisor is still alive and inspectable.
  const listed = await harness.json<ListValue>(["list"]);
  assert.equal(listed.code, 0);

  const doctor = await harness.json<DoctorValue>(["doctor"]);
  assert.equal(doctor.code, 1);
  assert.equal(doctor.value.ok, false);
  assert.ok(
    doctor.value.checks.some(
      (check) => check.name === "config" && check.status === "fail",
    ),
  );
  assert.ok(
    doctor.value.checks.some(
      (check) => check.name === "backends" && check.status === "fail",
    ),
  );
});
