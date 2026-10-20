import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  PROTOCOL_CAPABILITIES,
  WIRE_PROTOCOL_VERSION,
} from "../../src/protocol.js";

const root = new URL("../../../", import.meta.url);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, root)), "utf8");
}

test("package, lock, CLI, skill, and changelog versions agree", async () => {
  const pkg = JSON.parse(read("package.json")) as { version: string };
  const lock = JSON.parse(read("package-lock.json")) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  // Read the built artifacts, not the test build: dist/version.ts resolves
  // package.json relative to dist/, while dist-test/src/ has no package.
  const { VERSION } = (await import(
    new URL("dist/version.js", root).href
  )) as { VERSION: string };
  const { SKILL_VERSION } = (await import(
    new URL("dist/skill.js", root).href
  )) as { SKILL_VERSION: string };
  assert.equal(VERSION, pkg.version);
  assert.equal(SKILL_VERSION, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""]?.version, pkg.version);
  assert.match(read("CHANGELOG.md"), new RegExp(`^## ${pkg.version} —`, "m"));
});

test("the wire is 2.7 with provider-state, elicitation, and resume capabilities", () => {
  assert.deepEqual(WIRE_PROTOCOL_VERSION, { major: 2, minor: 7 });
  const capabilities = PROTOCOL_CAPABILITIES as readonly string[];
  for (const capability of [
    "session.compaction",
    "session.notices",
    "session.plan",
    "session.title",
    "session.agent",
    "session.messages",
    "session.elicitation",
    "spawn.resume",
    "spawn.fork",
  ]) {
    assert.ok(capabilities.includes(capability), capability);
  }
});
