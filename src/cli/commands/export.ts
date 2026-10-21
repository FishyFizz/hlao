import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  booleanOption,
  expectPositionals,
  numberOption,
  parseArgs,
  stringOption,
  usageError,
} from "../args.js";
import {
  COMMON,
  connect,
  contextFrom,
  out,
  resolveTarget,
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { exportAll, exportSession } from "./exporting.js";

/**
 * Export the full retained history, not one bounded page. History is lost on
 * `down`, so this is the supported recovery path; it reports truncation when
 * the log had already evicted events.
 */
export async function cmdExport(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "self", type: "boolean" },
    { name: "all", type: "boolean" },
    { name: "since", type: "number", valueName: "SEQ" },
    { name: "raw", type: "boolean" },
    { name: "jsonl", type: "boolean" },
    { name: "out", type: "path", valueName: "FILE" },
  ]);
  if (helpRequested(parsed, "export")) return 0;
  const all = booleanOption(parsed, "all") === true;
  expectPositionals(parsed, "export", all ? 0 : 0, all ? 0 : 1);

  const ctx = contextFrom(parsed);
  if (ctx.json && booleanOption(parsed, "jsonl") === true) {
    throw usageError("choose --json or --jsonl");
  }
  if (ctx.jsonEnvelope && booleanOption(parsed, "jsonl") === true) {
    throw usageError("--json=envelope cannot be combined with --jsonl");
  }
  const raw = booleanOption(parsed, "raw") === true;
  const jsonl = booleanOption(parsed, "jsonl") === true;
  const outFile = stringOption(parsed, "out");
  const since = numberOption(parsed, "since") ?? 0;
  const conn = await connect(ctx);

  if (all) {
    if (outFile === undefined) {
      throw usageError("export --all requires --out DIR");
    }
    const manifest = await exportAll(conn, resolve(outFile), {
      since,
      raw,
      jsonl,
    });
    const exported = manifest.sessions.length - manifest.failures;
    if (ctx.json) {
      writeJson(manifest);
    } else {
      out(
        `exported ${exported} of ${manifest.sessions.length} session${manifest.sessions.length === 1 ? "" : "s"} to ${outFile}` +
          (manifest.failures > 0
            ? ctx.style.red(` · ${manifest.failures} failed (see manifest.json)`)
            : ""),
      );
    }
    return manifest.failures > 0 ? 1 : 0;
  }

  const sessionId = resolveTarget(parsed, "export", "selfDefault");
  const payload = await exportSession(conn, sessionId, { since, raw });
  const { events, earliestRetainedSeq, truncated } = payload;

  if (jsonl) {
    const body = events.map((event) => JSON.stringify(event)).join("\n");
    const text = body.length > 0 ? `${body}\n` : "";
    if (outFile !== undefined) {
      writeFileSync(resolve(outFile), text);
      if (!ctx.json) {
        out(
          `exported ${events.length} event${events.length === 1 ? "" : "s"} to ${outFile}`,
        );
      }
    } else {
      process.stdout.write(text);
    }
    return 0;
  }

  if (outFile !== undefined) {
    writeFileSync(resolve(outFile), `${JSON.stringify(payload, null, 2)}\n`);
    if (ctx.json) {
      writeJson(payload);
    } else {
      out(
        `exported ${events.length} event${events.length === 1 ? "" : "s"} to ${outFile}` +
          (truncated
            ? ctx.style.dim(` · history begins at seq ${earliestRetainedSeq}`)
            : ""),
      );
    }
    return 0;
  }

  // Without a file, JSON on stdout keeps `hlao export <id> > history.json` safe.
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}
