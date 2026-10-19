import { HlaoError } from "../errors.js";
import { parseDuration } from "../time.js";

export type OptionType = "boolean" | "string" | "number" | "duration";

export interface OptionSpec {
  name: string;
  short?: string;
  type: OptionType;
  multiple?: boolean;
  valueName?: string;
}

export interface ParsedArgs {
  options: Record<string, unknown>;
  positionals: string[];
}

export function parseArgs(argv: string[], spec: OptionSpec[]): ParsedArgs {
  const byName = new Map(spec.map((option) => [option.name, option]));
  const byShort = new Map(
    spec
      .filter((option) => option.short !== undefined)
      .map((option) => [option.short!, option]),
  );

  const options: Record<string, unknown> = {};
  const positionals: string[] = [];
  let endOfOptions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (endOfOptions) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      endOfOptions = true;
      continue;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      const rawName = equals >= 0 ? body.slice(0, equals) : body;
      const inlineValue = equals >= 0 ? body.slice(equals + 1) : undefined;

      if (rawName.startsWith("no-")) {
        const name = rawName.slice(3);
        const option = byName.get(name);
        if (option?.type === "boolean") {
          if (inlineValue !== undefined) {
            throw usageError(`--${rawName} does not take a value`);
          }
          options[name] = false;
          continue;
        }
      }

      const option = byName.get(rawName);
      if (!option) {
        throw usageError(`unknown option --${rawName}`);
      }
      if (option.type === "boolean") {
        if (inlineValue !== undefined) {
          throw usageError(`--${rawName} does not take a value`);
        }
        options[option.name] = true;
        continue;
      }

      let value = inlineValue;
      if (value === undefined) {
        index += 1;
        value = argv[index];
        if (value === undefined) {
          throw usageError(`--${option.name} needs a value`);
        }
      }
      assign(options, option, value);
      continue;
    }

    const short = token.slice(1);
    if (short.length !== 1) {
      throw usageError(`unknown option ${token}`);
    }
    const option = byShort.get(short);
    if (!option) throw usageError(`unknown option -${short}`);
    if (option.type === "boolean") {
      options[option.name] = true;
      continue;
    }
    index += 1;
    const value = argv[index];
    if (value === undefined) {
      throw usageError(`-${short} needs a value`);
    }
    assign(options, option, value);
  }

  return { options, positionals };
}

function assign(
  options: Record<string, unknown>,
  option: OptionSpec,
  raw: string,
): void {
  let value: unknown;
  switch (option.type) {
    case "string":
      value = raw;
      break;
    case "number": {
      const number = Number(raw);
      if (!Number.isInteger(number)) {
        throw usageError(`--${option.name} must be an integer`);
      }
      value = number;
      break;
    }
    case "duration":
      value = parseDuration(raw);
      break;
    default:
      throw usageError(`--${option.name} does not take a value`);
  }

  if (option.multiple) {
    const existing = options[option.name];
    if (Array.isArray(existing)) existing.push(value);
    else options[option.name] = [value];
  } else {
    options[option.name] = value;
  }
}

export function usageError(message: string): HlaoError {
  return new HlaoError("bad_request", message);
}

export function stringOption(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : undefined;
}

export function booleanOption(
  parsed: ParsedArgs,
  name: string,
): boolean | undefined {
  const value = parsed.options[name];
  return typeof value === "boolean" ? value : undefined;
}

export function numberOption(
  parsed: ParsedArgs,
  name: string,
): number | undefined {
  const value = parsed.options[name];
  return typeof value === "number" ? value : undefined;
}

export function multipleOption(
  parsed: ParsedArgs,
  name: string,
): string[] {
  const value = parsed.options[name];
  return Array.isArray(value) ? (value as string[]) : [];
}
