#!/usr/bin/env node
import { main } from "./cli/main.js";

process.title = "hlao";

/**
 * A short reader (`hlao export <id> --jsonl | head`) closes the pipe while the
 * CLI is still writing. Node reports that as an unhandled 'error' event and
 * prints a stack trace; a broken pipe is a normal end of output for a CLI, so
 * exit quietly instead.
 */
function exitOnBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
    if (stream !== process.stderr) {
      try {
        process.stderr.write(`hlao: output error: ${error.message}\n`);
      } catch {
        // stderr is gone too; there is nowhere left to report.
      }
    }
    process.exit(1);
  });
}

exitOnBrokenPipe(process.stdout);
exitOnBrokenPipe(process.stderr);

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`hlao: ${(error as Error).message ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
