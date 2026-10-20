import assert from "node:assert/strict";
import { test } from "node:test";
import { commandHelp, fullHelp, suggestCommands } from "../../src/cli/help.js";

test("help teaches universal addressing and drops removed scope language", () => {
  const commands = [
    "spawn",
    "send",
    "read",
    "export",
    "get",
    "find",
    "wait",
    "list",
    "cancel",
    "close",
    "permit",
    "mode",
    "policy",
    "option",
    "queue",
    "rename",
    "agents",
    "status",
    "logs",
    "config",
    "reload",
    "doctor",
    "whoami",
    "down",
  ];
  const text = [fullHelp(), ...commands.map((command) => commandHelp(command))].join(
    "\n",
  );

  assert.doesNotMatch(text, /descendants only|parent may|sees itself/);
  assert.match(text, /addressable by every caller/);
  assert.match(commandHelp("policy"), /any caller in the instance/);
  assert.match(commandHelp("wait"), /historical completion condition/);
  assert.match(commandHelp("list"), /--cwd DIR \(exact working directory\)/);
  assert.match(commandHelp("get"), /--brief/);
  assert.doesNotMatch(
    fullHelp(),
    /send --self "Check the log again\." --wait/,
  );
});

test("mistyped commands suggest the nearest names", () => {
  assert.equal(suggestCommands("lst")[0], "list");
  assert.ok(suggestCommands("sernd").includes("send"));
  assert.deepEqual(suggestCommands("frobnicate"), []);
});
