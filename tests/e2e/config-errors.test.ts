import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Harness,
  type DoctorValue,
  type JsonError,
} from "./harness.js";

test("invalid user config fails startup instead of creating an empty instance", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  harness.writeConfig({ permissionPolicy: "allow", waitTime: 1000 });

  const spawned = await harness.json<JsonError>(["spawn", "fake"]);
  assert.equal(spawned.code, 1);
  assert.equal(spawned.value.error.code, "config_invalid");
  assert.match(spawned.value.error.message, /unknown field "waitTime"/);

  // The first command a user runs must report the config failure, not an
  // empty instance with exit 0.
  const listed = await harness.json<JsonError>(["list"]);
  assert.equal(listed.code, 1);
  assert.equal(listed.value.error.code, "config_invalid");
  assert.match(listed.value.error.message, /config\.json/);
  assert.equal(
    (listed.value.error.message.match(/config\.json/g) ?? []).length,
    1,
    "the config path is named once",
  );

  const agents = await harness.json<JsonError>(["agents"]);
  assert.equal(agents.code, 1);
  assert.equal(agents.value.error.code, "config_invalid");

  const started = await harness.json<JsonError>(["status", "--start"]);
  assert.equal(started.code, 1);
  assert.equal(started.value.error.code, "config_invalid");

  // Doctor inspects locally and fails without starting a supervisor.
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
