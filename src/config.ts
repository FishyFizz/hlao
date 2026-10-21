import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { HlaoError, describeError } from "./errors.js";
import { configPath, projectBackendsPath } from "./paths.js";
import type { AgentView } from "./protocol.js";

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
  /** The mode a spawn uses when the operator supplies none (3.0). */
  defaultMode?: string;
}

export interface HlaoConfig {
  waitTimeoutMs: number;
  sendWaitTimeoutMs: number;
  startupTimeoutMs: number;
  permissionTimeoutMs: number;
  maxPendingPermissions: number;
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
  "waitTimeoutMs",
  "sendWaitTimeoutMs",
  "startupTimeoutMs",
  "permissionTimeoutMs",
  "maxPendingPermissions",
  "maxEventsPerSession",
  "maxEventLogBytes",
  "maxEventBytes",
  "retainClosedMs",
  "backends",
] as const;

const PROJECT_KEYS = ["backends"] as const;
const BACKEND_KEYS = ["command", "args", "env", "description", "defaultMode"] as const;

export function defaults(): HlaoConfig {
  return {
    waitTimeoutMs: 30 * 60_000,
    sendWaitTimeoutMs: 30 * 60_000,
    startupTimeoutMs: 120_000,
    // A provider ask parks until the operator answers; fail closed after 30m.
    // 0 parks forever and is the documented unattended-diagnosis escape hatch.
    permissionTimeoutMs: 30 * 60_000,
    maxPendingPermissions: 16,
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
    // A removed key gets the migration message, not the generic unknown-key
    // error: it is the one config change every 0.14 operator must make.
    if (object.permissionPolicy !== undefined) {
      throw new HlaoError(
        "config_invalid",
        "config.permissionPolicy was removed in 0.15 (protocol 3.0); the provider mode is the permission policy now. Remove it and set backends.<name>.defaultMode (for example \"auto\"), or pass --mode from an operator shell. Pending requests are answered with \"hlao permit\".",
      );
    }
    checkKeys(object, USER_KEYS, "config");

    // Build and validate into a fresh object; commit only if every field passes.
    // A partly-applied config is worse than none.
    const next = defaults();

    next.waitTimeoutMs =
      optionalInt(object, "waitTimeoutMs", "config", 0, 604_800_000) ??
      next.waitTimeoutMs;
    next.sendWaitTimeoutMs =
      optionalInt(object, "sendWaitTimeoutMs", "config", 0, 604_800_000) ??
      next.sendWaitTimeoutMs;
    next.startupTimeoutMs =
      optionalInt(object, "startupTimeoutMs", "config", 1_000, 3_600_000) ??
      next.startupTimeoutMs;
    next.permissionTimeoutMs =
      optionalInt(object, "permissionTimeoutMs", "config", 0, 604_800_000) ??
      next.permissionTimeoutMs;
    next.maxPendingPermissions =
      optionalInt(object, "maxPendingPermissions", "config", 1, 1_000) ??
      next.maxPendingPermissions;
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
  try {
    const object = asObject(readJson(file), "project config");
    checkKeys(object, PROJECT_KEYS, "project config");
    if (object.backends === undefined) return {};
    return parseBackendMap(object.backends, "project", file);
  } catch (error) {
    const converted =
      error instanceof HlaoError
        ? error
        : new HlaoError("config_invalid", describeError(error));
    throw new HlaoError(
      "config_invalid",
      `${file}: ${converted.message}`,
      converted.details,
    );
  }
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
    ...(manifest.defaultMode !== undefined
      ? { defaultMode: manifest.defaultMode }
      : {}),
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
    opencode: externalBuiltin(
      "opencode",
      "opencode",
      ["acp"],
      "OpenCode through its ACP server",
      // Windows npm installs leave only a .cmd shim on PATH; the shim wraps
      // the platform binary under the prefix's node_modules. Both the v2
      // (@opencode/cli) and v1 (opencode-ai) package layouts are known.
      [
        join("node_modules", "@opencode", "cli", "bin", "opencode.exe"),
        join("node_modules", "opencode-ai", "bin", "opencode.exe"),
      ],
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

/**
 * A builtin for a tool the operator installs themselves. The command is
 * resolved on PATH to something this process can actually spawn, so a Windows
 * npm shim is never reported as READY.
 */
function externalBuiltin(
  name: string,
  command: string,
  args: string[],
  description: string,
  shimTargets: readonly string[],
): BackendManifest {
  const resolved = resolveSpawnable(command, shimTargets);
  return {
    name,
    command: resolved.executable ?? command,
    args,
    env: {},
    description,
    source: "builtin",
    available: resolved.available,
    ...(resolved.reason !== undefined
      ? { unavailableReason: resolved.reason }
      : {}),
  };
}

interface SpawnableResolution {
  available: boolean;
  executable?: string;
  reason?: string;
}

/**
 * Finds a PATH entry that can be passed to `spawn` without a shell. On Windows
 * that means `.exe`/`.com`; an npm global install leaves a `.cmd` shim there,
 * so the declared shim targets (the wrapped binary inside the same prefix) are
 * tried before reporting the shim problem.
 */
function resolveSpawnable(
  command: string,
  shimTargets: readonly string[],
): SpawnableResolution {
  const windows = process.platform === "win32";
  const extensions = windows
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter((extension) => extension.length > 0)
    : [""];
  let problem: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    let shimFound = false;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (!existsSync(candidate)) continue;
      if (isSpawnable(candidate)) {
        return { available: true, executable: candidate };
      }
      shimFound = true;
      problem ??= spawnProblem(command, candidate);
    }
    if (!windows) continue;
    // npm's POSIX launcher lands on PATH without an extension too.
    const bare = join(directory, command);
    if (existsSync(bare) && !isSpawnable(bare)) {
      shimFound = true;
      problem ??= spawnProblem(command, bare);
    }
    if (!shimFound) continue;
    for (const target of shimTargets) {
      const wrapped = join(directory, target);
      if (existsSync(wrapped) && isSpawnable(wrapped)) {
        return { available: true, executable: wrapped };
      }
    }
  }
  return problem !== undefined
    ? { available: false, reason: problem }
    : {
        available: false,
        reason: `command "${command}" was not found on PATH`,
      };
}

function isSpawnable(file: string): boolean {
  if (process.platform === "win32") {
    const extension = extname(file).toLowerCase();
    return extension === ".exe" || extension === ".com";
  }
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function spawnProblem(command: string, candidate: string): string {
  if (process.platform !== "win32") {
    return `command "${command}" resolves to ${basename(candidate)}, which is not executable`;
  }
  const extension = extname(candidate).toLowerCase();
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    return (
      `command "${command}" resolves to ${basename(candidate)}, a Windows shell ` +
      `shim that cannot be spawned directly; point the backend at the executable it wraps`
    );
  }
  return (
    `command "${command}" resolves to ${basename(candidate)}, which is not a ` +
    `Windows executable (.exe or .com)`
  );
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

  let defaultMode: string | undefined;
  if (object.defaultMode !== undefined) {
    if (
      typeof object.defaultMode !== "string" ||
      object.defaultMode.trim().length === 0
    ) {
      throw new HlaoError(
        "config_invalid",
        `backend "${name}".defaultMode must be a non-empty mode id`,
      );
    }
    defaultMode = object.defaultMode;
  }

  const resolution = resolveCommand(command);
  return {
    name,
    command,
    args,
    env,
    description,
    source,
    configPath: filePath,
    available: resolution.available,
    ...(resolution.reason !== undefined
      ? { unavailableReason: resolution.reason }
      : {}),
    ...(defaultMode !== undefined ? { defaultMode } : {}),
  };
}

interface CommandResolution {
  available: boolean;
  reason?: string;
}

/**
 * Resolves a command the way the OS would, without launching it. A Windows
 * `.cmd`/`.bat`/`.ps1` shim exists but cannot be spawned without a shell, so it
 * is reported unavailable with the reason rather than failing at spawn time.
 */
function resolveCommand(command: string): CommandResolution {
  const check = (candidate: string): CommandResolution =>
    shimReason(command, candidate) ?? { available: true };

  if (isAbsolute(command)) {
    if (!existsSync(command)) {
      return { available: false, reason: `command "${command}" was not found` };
    }
    return check(command);
  }
  // A relative path is resolved by spawn against the session cwd, which is not
  // known here; do not guess and mark a usable backend unavailable.
  if (command.includes("/") || command.includes("\\")) return { available: true };
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter((extension) => extension.length > 0)
      : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    const direct = join(directory, command);
    if (existsSync(direct)) return check(direct);
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return check(candidate);
    }
  }
  return {
    available: false,
    reason: `command "${command}" was not found on PATH`,
  };
}

function shimReason(command: string, candidate: string): CommandResolution | null {
  if (process.platform !== "win32") return null;
  const extension = extname(candidate).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat" && extension !== ".ps1") {
    return null;
  }
  return {
    available: false,
    reason:
      `command "${command}" resolves to ${basename(candidate)}, a Windows shell ` +
      `shim that cannot be spawned directly; point the backend at the executable it wraps`,
  };
}

// --- small validation helpers ---------------------------------------------

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // The caller prefixes the file path; do not repeat it here.
    throw new HlaoError("config_invalid", `cannot parse: ${describeError(error)}`);
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
