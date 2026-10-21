import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectSupervisor } from "../../src/client.js";
import { HlaoError } from "../../src/errors.js";
import { probeSupervisor, readLock, type LockInfo } from "../../src/lock.js";

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

/**
 * A live old-major supervisor, modeled as a token-checked NDJSON hello server
 * behind a lock. The 3.0 client must report it and leave the lock in place.
 */
async function oldMajorSupervisor(home: string): Promise<{
  lock: LockInfo;
  close: () => Promise<void>;
}> {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hlao-mismatch-${process.pid}-${Date.now().toString(36)}`
      : join(home, "old.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: number };
      socket.write(
        `${JSON.stringify({
          id: request.id,
          ok: true,
          result: { protocolVersion: { major: 2, minor: 9 } },
        })}\n`,
      );
      socket.end();
    });
  });
  server.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  const lock: LockInfo = {
    pid: process.pid,
    token: "old-token",
    endpoint,
    protocolVersion: 2,
    startedAt: new Date().toISOString(),
    version: "0.14.0",
    state: "running",
  };
  writeFileSync(join(home, "supervisor.json"), JSON.stringify(lock));
  return {
    lock,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test("a live old-major supervisor is reported, not replaced", async () => {
  const home = mkdtempSync(join(tmpdir(), "hlao-mismatch-"));
  const old = await oldMajorSupervisor(home);
  try {
    const probe = await probeSupervisor(old.lock, 2_000);
    assert.deepEqual(probe, { alive: true, major: 2 });

    await assert.rejects(
      connectSupervisor({
        home,
        cliPath: CLI_ENTRY,
        callerSessionId: null,
        autostart: false,
      }),
      (error: unknown) =>
        error instanceof HlaoError &&
        error.code === "version_mismatch" &&
        /Stop the old supervisor/.test(error.message),
    );

    // Its lock is untouched: same token, same major.
    assert.equal(readLock(home)?.token, "old-token");
    assert.equal(readLock(home)?.protocolVersion, 2);

    // Scripts that opt in (down) may still use the legacy connection path.
    const legacy = await connectSupervisor({
      home,
      cliPath: CLI_ENTRY,
      callerSessionId: null,
      autostart: false,
      allowLegacyProtocol: true,
    });
    assert.equal(legacy.lock.token, "old-token");

    // A 3.0 supervisor start refuses to clobber the live old-major lock.
    const supervisor = spawn(process.execPath, [CLI_ENTRY, "__supervisor", "--home", home], {
      stdio: "ignore",
      windowsHide: true,
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      supervisor.once("exit", (code) => resolve(code));
    });
    assert.equal(exitCode, 1);
    assert.equal(readLock(home)?.token, "old-token");
  } finally {
    await old.close();
    rmSync(home, { recursive: true, force: true });
  }
});
