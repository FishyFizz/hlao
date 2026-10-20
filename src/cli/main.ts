import { toHlaoError } from "../errors.js";
import { resolveHome } from "../paths.js";
import { runSupervisor } from "../supervisor.js";
import { VERSION } from "../version.js";
import {
  booleanOption,
  expectPositionals,
  parseArgs,
  stringOption,
  usageError,
} from "./args.js";
import {
  cmdCancel,
  cmdClose,
  cmdGet,
  cmdMode,
  cmdOption,
  cmdPermit,
  cmdPolicy,
  cmdQueue,
  cmdRename,
} from "./commands/control.js";
import { cmdFind } from "./commands/find.js";
import { cmdList } from "./commands/list.js";
import {
  cmdExport,
  cmdRead,
  cmdSend,
  cmdSpawn,
  cmdWait,
} from "./commands/prompts.js";
import {
  cmdAgents,
  cmdConfig,
  cmdDoctor,
  cmdDown,
  cmdLogs,
  cmdReload,
  cmdStatus,
  cmdWhoami,
} from "./commands/ops.js";
import {
  CLI_ENTRY,
  COMMON,
  configureJsonEnvelope,
  renderError,
  setJsonEnvelope,
  writeJson,
  writeJsonFailure,
} from "./context.js";
import {
  commandHelp,
  fullHelp,
  hasCommandHelp,
} from "./help.js";

export async function main(argv: string[]): Promise<number> {
  // `--json=envelope` is accepted anywhere before `--` and expands to the
  // boolean pair the option parser understands.
  const normalized = argv.flatMap((token) =>
    token === "--json=envelope" ? ["--json", "--json-envelope"] : [token],
  );
  const endOfOptions = normalized.indexOf("--");
  const beforeEnd =
    endOfOptions === -1 ? normalized : normalized.slice(0, endOfOptions);
  const jsonRequested = beforeEnd.includes("--json");
  const envelopeRequested = beforeEnd.includes("--json-envelope");
  setJsonEnvelope(envelopeRequested);
  try {
    const { rest, injected } = splitLeadingGlobals(normalized);
    const first = rest[0];
    if (first === "__supervisor") {
      const parsed = parseArgs([...rest.slice(1), ...injected], COMMON);
      const home = resolveHome(stringOption(parsed, "home"), process.env);
      return await runSupervisor(home, CLI_ENTRY, VERSION);
    }

    if (first === undefined || first === "--help" || first === "-h") {
      if (jsonRequested) {
        configureJsonEnvelope("help");
        writeJson({ topic: null, help: fullHelp() });
      } else {
        process.stdout.write(`${fullHelp()}\n`);
      }
      return 0;
    }
    if (first === "help") {
      const parsed = parseArgs([...rest.slice(1), ...injected], COMMON);
      expectPositionals(parsed, "help", 0, 1);
      const topic = parsed.positionals[0];
      if (topic !== undefined && !hasCommandHelp(topic)) {
        throw usageError(`unknown help topic "${topic}" — run "hlao help"`);
      }
      const text = topic ? commandHelp(topic) : fullHelp();
      const json = booleanOption(parsed, "json") ?? jsonRequested;
      if (json) {
        configureJsonEnvelope("help");
        writeJson({ topic: topic ?? null, help: text });
      } else {
        process.stdout.write(`${text}\n`);
      }
      return 0;
    }
    if (first === "version" || first === "--version" || first === "-v") {
      if (jsonRequested) {
        configureJsonEnvelope("version");
        writeJson({ version: VERSION });
      } else {
        process.stdout.write(`hlao ${VERSION}\n`);
      }
      return 0;
    }

    configureJsonEnvelope(first);
    const args = [...rest.slice(1), ...injected];
    switch (first) {
      case "spawn":
        return await cmdSpawn(args);
      case "send":
        return await cmdSend(args);
      case "read":
        return await cmdRead(args);
      case "export":
        return await cmdExport(args);
      case "wait":
        return await cmdWait(args);
      case "list":
        return await cmdList(args);
      case "get":
        return await cmdGet(args);
      case "find":
        return await cmdFind(args);
      case "cancel":
        return await cmdCancel(args);
      case "close":
        return await cmdClose(args);
      case "permit":
        return await cmdPermit(args);
      case "mode":
        return await cmdMode(args);
      case "policy":
        return await cmdPolicy(args);
      case "option":
        return await cmdOption(args);
      case "queue":
        return await cmdQueue(args);
      case "rename":
        return await cmdRename(args);
      case "agents":
        return await cmdAgents(args);
      case "status":
        return await cmdStatus(args);
      case "logs":
        return await cmdLogs(args);
      case "config":
        return await cmdConfig(args);
      case "reload":
        return await cmdReload(args);
      case "doctor":
        return await cmdDoctor(args);
      case "whoami":
        return await cmdWhoami(args);
      case "down":
        return await cmdDown(args);
      default:
        throw usageError(`unknown command "${first}" — run "hlao help"`);
    }
  } catch (error) {
    const converted = toHlaoError(error);
    if (jsonRequested) {
      writeJsonFailure({
        code: converted.code,
        message: converted.message,
        ...(converted.details !== undefined ? { details: converted.details } : {}),
      });
    } else {
      process.stderr.write(renderError(converted));
    }
    return 1;
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function splitLeadingGlobals(argv: string[]): { rest: string[]; injected: string[] } {
  const injected: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "--json" || token === "--json-envelope") {
      injected.push(token);
      index += 1;
      continue;
    }
    if (token === "--home") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usageError("--home needs a directory");
      }
      injected.push("--home", value);
      index += 2;
      continue;
    }
    if (token.startsWith("--home=")) {
      injected.push(token);
      index += 1;
      continue;
    }
    break;
  }
  return { rest: argv.slice(index), injected };
}
