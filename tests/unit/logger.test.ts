import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Logger } from "../../src/logger.js";

test("the supervisor log rotates while running, keeping one previous file", (t) => {
  const home = mkdtempSync(join(tmpdir(), "hlao-log-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const path = join(home, "supervisor.log");
  const filler = "x".repeat(2 * 1024 * 1024 - 10);
  writeFileSync(path, filler);

  const logger = new Logger(home);
  logger.info("after the limit");

  assert.ok(existsSync(`${path}.1`));
  assert.equal(readFileSync(`${path}.1`, "utf8"), filler);
  assert.match(readFileSync(path, "utf8"), /after the limit/);
});
