import assert from "node:assert/strict";
import { test } from "node:test";
import { commandHelp, fullHelp } from "../../src/cli/help.js";

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
});
