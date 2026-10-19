import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type SpawnValue } from "./harness.js";

test("identity is injected into the adapter environment before it starts", async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const parent = await harness.json<SpawnValue>(["spawn", "fake", "parent", "--wait"]);
  const parentId = parent.value.session.id;

  const child = await harness.json<SpawnValue>(
    ["spawn", "fake", "go", "--env", "FAKE_MODE=env", "--wait"],
    { env: { HLAO_SESSION_ID: parentId } },
  );
  assert.equal(child.code, 0);
  const text = child.value.firstTurn?.text ?? "";
  assert.match(text, /^ENV /);
  const injected = JSON.parse(text.slice(4)) as Record<string, string | null>;

  assert.equal(injected.sessionId, child.value.session.id);
  assert.equal(injected.parentId, parentId);
  assert.equal(injected.rootId, parentId);
  assert.equal(injected.depth, "1");
  assert.equal(injected.backend, "fake");
  assert.equal(injected.home, harness.home);
  assert.equal(injected.cli, harness.cliEntry);
});
