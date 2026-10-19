import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectSupervisor } from "../../src/client.js";
import { HlaoError } from "../../src/errors.js";

const CLI_ENTRY = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));

test("a non-autostart probe does not create the runtime home", async () => {
  const home = join(
    tmpdir(),
    `hlao-absent-${process.pid}-${Date.now().toString(36)}`,
  );
  assert.equal(existsSync(home), false);

  await assert.rejects(
    connectSupervisor({
      home,
      cliPath: CLI_ENTRY,
      callerSessionId: null,
      autostart: false,
    }),
    (error: unknown) =>
      error instanceof HlaoError && error.code === "supervisor_unavailable",
  );

  assert.equal(existsSync(home), false);
});
