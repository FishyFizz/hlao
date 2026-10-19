import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadConfig,
  loadProjectBackends,
  mergeBackends,
} from "../../src/config.js";
import { HlaoError } from "../../src/errors.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "hlao-config-"));
}

test("defaults load when no config exists", () => {
  const home = tempHome();
  try {
    const { config, error } = loadConfig(home);
    assert.equal(error, null);
    assert.equal(config.permissionPolicy, "allow");
    assert.equal(config.waitTimeoutMs, 30 * 60_000);
    assert.ok(config.backends.claude);
    assert.ok(config.backends.codex);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("user backends override built-ins and carry their source", () => {
  const home = tempHome();
  try {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        permissionPolicy: "allow",
        backends: {
          fake: {
            command: "node",
            args: ["agent.js"],
            env: { FAKE_MODE: "echo" },
            description: "test",
          },
          claude: { command: "node", args: ["other.js"] },
        },
      }),
    );
    const { config, error } = loadConfig(home);
    assert.equal(error, null);
    assert.equal(config.permissionPolicy, "allow");
    assert.equal(config.backends.fake?.source, "user");
    assert.deepEqual(config.backends.fake?.args, ["agent.js"]);
    assert.equal(
      config.backends.fake?.configPath,
      join(home, "config.json"),
    );
    assert.equal(config.backends.claude?.source, "user");
    assert.deepEqual(config.backends.claude?.args, ["other.js"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an invalid config applies none of its values", () => {
  const home = tempHome();
  try {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ permissionPolicy: "allow", waitTimeoutMs: "nope" }),
    );
    const { config, error } = loadConfig(home);
    assert.ok(error instanceof HlaoError);
    assert.equal(error.code, "config_invalid");
    assert.match(error.message, /config\.json/);
    // The valid-looking field must not leak through from an invalid file.
    assert.equal(config.permissionPolicy, "allow");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a custom backend whose command cannot be found is not ready", () => {
  const home = tempHome();
  try {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        backends: {
          ghost: { command: "definitely-not-a-real-command-hlao-xyz" },
        },
      }),
    );
    const { config, error } = loadConfig(home);
    assert.equal(error, null);
    assert.equal(config.backends.ghost?.available, false);
    assert.match(config.backends.ghost?.unavailableReason ?? "", /not found/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown config keys are rejected rather than ignored", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "config.json"), JSON.stringify({ waitTime: 1_000 }));
    const { error } = loadConfig(home);
    assert.ok(error instanceof HlaoError);
    assert.equal(error.code, "config_invalid");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("project backends are read per cwd and override user backends", () => {
  const home = tempHome();
  const project = tempHome();
  try {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        backends: {
          shared: { command: "node", args: ["user.js"] },
        },
      }),
    );
    mkdirSync(join(project, ".hlao"));
    writeFileSync(
      join(project, ".hlao", "agents.json"),
      JSON.stringify({
        backends: {
          shared: { command: "node", args: ["project.js"] },
        },
      }),
    );

    const { config } = loadConfig(home);
    const merged = mergeBackends(config.backends, project);
    assert.equal(merged.shared?.source, "project");
    assert.deepEqual(merged.shared?.args, ["project.js"]);
    assert.equal(merged.shared?.name, "shared");
    assert.equal(
      merged.shared?.configPath,
      join(project, ".hlao", "agents.json"),
    );
    assert.deepEqual(loadProjectBackends(project).shared?.args, ["project.js"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("invalid project config fails that request with config_invalid", () => {
  const project = tempHome();
  try {
    mkdirSync(join(project, ".hlao"));
    writeFileSync(
      join(project, ".hlao", "agents.json"),
      JSON.stringify({ backends: { broken: { args: [] } } }),
    );
    assert.throws(
      () => loadProjectBackends(project),
      (error: unknown) =>
        error instanceof HlaoError && error.code === "config_invalid",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
