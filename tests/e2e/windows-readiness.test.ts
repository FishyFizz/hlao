import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Harness } from "./harness.js";

const windows = process.platform === "win32";

interface AgentList {
  agents: {
    name: string;
    available: boolean;
    unavailableReason?: string;
  }[];
}

test("a Windows shell shim is present but not spawnable", { skip: !windows }, async (t) => {
  const harness = new Harness();
  t.after(() => harness.cleanup());

  const shim = join(harness.home, "adapter.cmd");
  writeFileSync(shim, "@echo off\r\nexit /b 0\r\n");
  writeFileSync(
    join(harness.home, "config.json"),
    JSON.stringify(
      {
        backends: {
          shimmed: { command: shim, args: [] },
        },
      },
      null,
      2,
    ),
  );

  const agents = await harness.json<AgentList>(["agents"]);
  assert.equal(agents.code, 0);
  const shimmed = agents.value.agents.find((agent) => agent.name === "shimmed");
  assert.ok(shimmed);
  assert.equal(shimmed.available, false);
  assert.match(shimmed.unavailableReason ?? "", /shell shim/);
  assert.match(shimmed.unavailableReason ?? "", /adapter\.cmd/);
  assert.match(shimmed.unavailableReason ?? "", /spawned directly/);
});
