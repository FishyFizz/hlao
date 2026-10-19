import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { HlaoError, describeError } from "./errors.js";
import { configPath, projectBackendsPath } from "./paths.js";
import type { AgentView, PermissionPolicy } from "./protocol.js";

const require = createRequire(import.meta.url);

export interface BackendManifest {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  description?: string;
  source: "builtin" | "user" | "project";
  /** The config file that defined a user or project backend. */
  configPath?: string;
  available: boolean;
  unavailableReason?: string;
}

export interface HlaoConfig {
  permissionPolicy: PermissionPolicy;
  waitTimeoutMs: number;
  sendWaitTimeoutMs: number;
  startupTimeoutMs: number;
  maxEventsPerSession: number;
  maxEventLogBytes: number;
  maxEventBytes: number;
  retainClosedMs: number;
  backends: Record<string, BackendManifest>;
}

export interface ConfigLoadResult {
  config: HlaoConfig;
  error: HlaoError | null;
}

const USER_KEYS = [
  "permissionPolicy",
  "waitTimeoutMs",
  "sendWaitTimeoutMs",
  "startupTimeoutMs",
  "maxEventsPerSession",
  "maxEventLogBytes",
  "maxEventBytes",
  "retainClosedMs",
  "backends",
] as const;

const PROJECT_KEYS = ["backends"] as const;
const BACKEND_KEYS = ["command", "args", "env", "description"] as const;

export function defaults(): HlaoConfig {
  return {
    // A single operator driving their own work: the provider's own permission
    // modes still apply, and asking on every tool call makes an agent hang.
    // Use "ask" for a gated session or set a config file value.
    permissionPolicy: "allow",
    waitTimeoutMs: 30 * 60_000,
    sendWaitTimeoutMs: 30 * 60_000,
    startupTimeoutMs: 120_000,
    maxEventsPerSession: 5_000,
    maxEventLogBytes: 16 * 1024 * 1024,
    maxEventBytes: 256 * 1024,
    retainClosedMs: 60 * 60_000,
    backends: builtins(),
  };
}

export function loadConfig(home: string): ConfigLoadResult {
  const file = configPath(home);
  if (!existsSync(file)) return { config: defaults(), error: null };

  try {
    const raw = readJson(file);
    const object = asObject(raw, "config");
    checkKeys(object, USER_KEYS, "config");

    // Build and validate into a fresh object; commit only if every field passes.
    // A partly-applied config (especially permissionPolicy) is worse than none.
    const next = defaults();

    const policy = optionalEnum(object, "permissionPolicy", "config", [
      "ask",
      "allow",
      "deny",
    ] as const);
    if (policy) next.permissionPolicy = policy;

    next.waitTimeoutMs =
      optionalInt(object, "waitTimeoutMs", "config", 0, 604_800_000) ??
      next.waitTimeoutMs;
    next.sendWaitTimeoutMs =
      optionalInt(object, "sendWaitTimeoutMs", "config", 0, 604_800_000) ??
      next.sendWaitTimeoutMs;
    next.startupTimeoutMs =
      optionalInt(object, "startupTimeoutMs", "config", 1_000, 3_600_000) ??
      next.startupTimeoutMs;
    next.maxEventsPerSession =
      optionalInt(object, "maxEventsPerSession", "config", 1, 1_000_000) ??
      next.maxEventsPerSession;
    next.maxEventLogBytes =
      optionalInt(object, "maxEventLogBytes", "config", 1_024, 2_147_483_648) ??
      next.maxEventLogBytes;
    next.maxEventBytes =
      optionalInt(object, "maxEventBytes", "config", 1_024, 67_108_864) ??
      next.maxEventBytes;
    next.retainClosedMs =
      optionalInt(object, "retainClosedMs", "config", 0, 2_592_000_000) ??
      next.retainClosedMs;

    const userBackends = object.backends;
    if (userBackends !== undefined) {
      const merged = parseBackendMap(userBackends, "user", configPath(home));
      for (const [name, manifest] of Object.entries(merged)) {
        next.backends[name] = manifest;
      }
    }

    return { config: next, error: null };
  } catch (error) {
    const converted =
      error instanceof HlaoError
        ? error
        : new HlaoError("config_invalid", describeError(error));
    return {
      config: defaults(),
      error: new HlaoError(
        "config_invalid",
        `${file}: ${converted.message}`,
        converted.details,
      ),
    };
  }
}

export function loadProjectBackends(cwd: string): Record<string, BackendManifest> {
  const file = projectBackendsPath(cwd);
  if (!existsSync(file)) return {};
  const object = asObject(readJson(file), "project config");
  checkKeys(object, PROJECT_KEYS, "project config");
  if (object.backends === undefined) return {};
  return parseBackendMap(object.backends, "project", file);
}

export function mergeBackends(
  base: Record<string, BackendManifest>,
  cwd: string,
): Record<string, BackendManifest> {
  const merged: Record<string, BackendManifest> = { ...base };
  const project = loadProjectBackends(cwd);
  for (const [name, manifest] of Object.entries(project)) merged[name] = manifest;
  return merged;
}

/** Fingerprint of the on-disk user config; "missing" when there is no file. */
export function configFingerprint(home: string): string {
  try {
    return createHash("sha256")
      .update(readFileSync(configPath(home)))
      .digest("hex");
  } catch {
    return "missing";
  }
}

/** A config safe to show: backend environment values are never printable. */
export function redactConfig(config: HlaoConfig): HlaoConfig {
  const backends: Record<string, BackendManifest> = {};
  for (const [name, manifest] of Object.entries(config.backends)) {
    const env: Record<string, string> = {};
    for (const key of Object.keys(manifest.env)) env[key] = "***";
    backends[name] = { ...manifest, env };
  }
  return { ...config, backends };
}

export function toAgentView(manifest: BackendManifest): AgentView {
  return {
    name: manifest.name,
    source: manifest.source,
    command: manifest.command,
    args: manifest.args,
    envKeys: Object.keys(manifest.env).sort(),
    description: manifest.description,
    ...(manifest.configPath ? { configPath: manifest.configPath } : {}),
    available: manifest.available,
    unavailableReason: manifest.unavailableReason,
  };
}

function builtins(): Record<string, BackendManifest> {
  return {
    claude: builtin(
      "claude",
      "@agentclientprotocol/claude-agent-acp/package.json",
      "Claude Code through the ACP adapter",
      (packageJsonPath) => join(dirname(packageJsonPath), "dist", "index.js"),
    ),
    codex: builtin(
      "codex",
      "@agentclientprotocol/codex-acp",
      "OpenAI Codex through the ACP adapter",
      (entry) => entry,
    ),
  };
}

function builtin(
  name: string,
  specifier: string,
  description: string,
  entryFrom: (resolved: string) => string,
): BackendManifest {
  try {
    const resolved = require.resolve(specifier);
    const entry = entryFrom(resolved);
    if (!existsSync(entry)) {
      return {
        name,
        command: process.execPath,
        args: [],
        env: {},
        description,
        source: "builtin",
        available: false,
        unavailableReason: `adapter entry not found at ${entry}`,
      };
    }
    return {
      name,
      command: process.execPath,
      args: [entry],
      env: {},
      description,
      source: "builtin",
      available: true,
    };
  } catch (error) {
    return {
      name,
      command: process.execPath,
      args: [],
      env: {},
      description,
      source: "builtin",
      available: false,
      unavailableReason: `cannot resolve ${specifier}: ${describeError(error)}`,
    };
  }
}

function parseBackendMap(
  value: unknown,
  source: "user" | "project",
  filePath: string,
): Record<string, BackendManifest> {
  const object = asObject(value, `${source} backends`);
  const result: Record<string, BackendManifest> = {};
  for (const [name, raw] of Object.entries(object)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      throw new HlaoError(
        "config_invalid",
        `${source} backend name "${name}" must be 1-64 letters, digits, dot, dash, or underscore`,
      );
    }
    result[name] = parseBackend(name, raw, source, filePath);
  }
  return result;
}

function parseBackend(
  name: string,
  value: unknown,
  source: "user" | "project",
  filePath: string,
): BackendManifest {
  const object = asObject(value, `${source} backend "${name}"`);
  checkKeys(object, BACKEND_KEYS, `${source} backend "${name}"`);

  const command = object.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new HlaoError("config_invalid", `backend "${name}".command must be a non-empty string`);
  }

  let args: string[] = [];
  if (object.args !== undefined) {
    if (!Array.isArray(object.args) || object.args.some((arg) => typeof arg !== "string")) {
      throw new HlaoError("config_invalid", `backend "${name}".args must be a string array`);
    }
    args = object.args as string[];
  }

  let env: Record<string, string> = {};
  if (object.env !== undefined) {
    const rawEnv = asObject(object.env, `backend "${name}".env`);
    env = {};
    for (const [key, entry] of Object.entries(rawEnv)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== "string") {
        throw new HlaoError(
          "config_invalid",
          `backend "${name}".env must map environment names to strings`,
        );
      }
      env[key] = entry;
    }
  }

  let description: string | undefined;
  if (object.description !== undefined) {
    if (typeof object.description !== "string") {
      throw new HlaoError(
        "config_invalid",
        `backend "${name}".description must be a string`,
      );
    }
    description = object.description;
  }

  const available = commandAvailable(command);
  return {
    name,
    command,
    args,
    env,
    description,
    source,
    configPath: filePath,
    available,
    ...(available
      ? {}
      : { unavailableReason: `command "${command}" was not found on PATH` }),
  };
}

/** Resolves a command the way the OS would, without launching it. */
function commandAvailable(command: string): boolean {
  if (isAbsolute(command)) return existsSync(command);
  // A relative path is resolved by spawn against the session cwd, which is not
  // known here; do not guess and mark a usable backend unavailable.
  if (command.includes("/") || command.includes("\\")) return true;
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter((extension) => extension.length > 0)
      : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    if (existsSync(join(directory, command))) return true;
    for (const extension of extensions) {
      if (existsSync(join(directory, `${command}${extension}`))) return true;
    }
  }
  return false;
}

// --- small validation helpers ---------------------------------------------

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new HlaoError("config_invalid", `cannot parse ${file}: ${describeError(error)}`);
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HlaoError("config_invalid", `${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function checkKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new HlaoError("config_invalid", `${what} has unknown field "${key}"`);
    }
  }
}

function optionalInt(
  object: Record<string, unknown>,
  key: string,
  what: string,
  min: number,
  max: number,
): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HlaoError(
      "config_invalid",
      `${what}.${key} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

function optionalEnum<T extends string>(
  object: Record<string, unknown>,
  key: string,
  what: string,
  allowed: readonly T[],
): T | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HlaoError(
      "config_invalid",
      `${what}.${key} must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}
