#!/usr/bin/env node
import { main } from "./cli/main.js";

process.title = "hlao";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`hlao: ${(error as Error).message ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
