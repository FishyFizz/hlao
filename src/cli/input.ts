import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HlaoError } from "../errors.js";
import {
  booleanOption,
  stringOption,
  usageError,
  type ParsedArgs,
} from "./args.js";

export async function resolveMessage(
  positionals: string[],
  parsed: ParsedArgs,
): Promise<string | undefined> {
  const positional = positionals.join(" ").trim();
  const prompt = stringOption(parsed, "prompt");
  const promptFile = stringOption(parsed, "prompt-file");
  const stdin = booleanOption(parsed, "stdin") ?? false;

  const sources = [
    positional.length > 0,
    prompt !== undefined,
    promptFile !== undefined,
    stdin,
  ].filter(Boolean).length;
  if (sources > 1) {
    throw usageError("provide the message one way: positional, --prompt, --prompt-file, or --stdin");
  }
  if (sources === 0) return undefined;

  let text: string;
  if (positional.length > 0) text = positional;
  else if (prompt !== undefined) text = prompt;
  else if (promptFile !== undefined) text = readTextFile(promptFile);
  else text = await readStdin();

  if (text.length === 0) throw usageError("the message is empty");
  return text;
}

function readTextFile(file: string): string {
  try {
    return stripTrailingNewline(readFileSync(resolve(file), "utf8"));
  } catch (error) {
    throw new HlaoError(
      "bad_request",
      `cannot read ${file}: ${(error as Error).message}`,
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return stripTrailingNewline(Buffer.concat(chunks).toString("utf8"));
}

function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

export function parseEnv(pairs: string[]): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) {
      throw usageError(`--env expects K=V, got "${pair}"`);
    }
    const key = pair.slice(0, equals);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw usageError(`--env name "${key}" is not a valid environment variable`);
    }
    env[key] = pair.slice(equals + 1);
  }
  return env;
}

export function parseConfigValues(
  pairs: string[],
): Record<string, string> | undefined {
  if (pairs.length === 0) return undefined;
  const config: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals <= 0) {
      throw usageError(`--config expects KEY=VALUE, got "${pair}"`);
    }
    const key = pair.slice(0, equals);
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) {
      throw usageError(`--config key "${key}" is not a valid option id`);
    }
    config[key] = pair.slice(equals + 1);
  }
  return config;
}

