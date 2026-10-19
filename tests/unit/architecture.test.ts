import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

/**
 * The client boundary (ADR 0007): core must not reach into the bundled CLI.
 * The reverse direction is expected — the CLI is a client.
 */
test("core modules do not import the CLI", () => {
  const root = resolve(process.cwd(), "src");
  const offenders: string[] = [];

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const rel = relative(root, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (rel === "cli") continue;
        visit(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (rel === "cli.ts") continue;
      const text = readFileSync(full, "utf8");
      const matches = text.matchAll(/from\s+["']([^"']*\/cli\/[^"']*)["']/g);
      for (const match of matches) {
        offenders.push(`${rel} imports ${match[1]}`);
      }
    }
  };

  visit(root);
  assert.deepEqual(offenders, []);
});
