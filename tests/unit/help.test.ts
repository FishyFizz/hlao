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
  assert.doesNotMatch(fullHelp(), /hlao policy /);
  assert.match(commandHelp("permit"), /operator-only/);
  assert.match(commandHelp("permit"), /--request ID/);
  assert.match(commandHelp("permit"), /--deny --always/);
  assert.match(commandHelp("mode"), /operator-only/);
  assert.match(commandHelp("mode"), /--root SESSION/);
  assert.match(commandHelp("spawn"), /defaultMode/);
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
  assert.equal(suggestCommands("policy").includes("policy"), false);
});
