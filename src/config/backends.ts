import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, extname, isAbsolute, join } from "node:path";
import type { BackendManifest } from "../config.js";
import { describeError } from "../errors.js";

const require = createRequire(import.meta.url);

/**
 * Backend discovery is a local property of the manifest and PATH, not of any
 * running session. This module answers one question for both builtins and
 * user/project backends: can `spawn` launch this command without a shell?
 */

export interface SpawnableResolution {
  available: boolean;
  /** Absolute path to the executable, when a resolver found one. */
  executable?: string;
  reason?: string;
}

export interface CommandResolution {
  available: boolean;
  reason?: string;
}

export function builtins(): Record<string, BackendManifest> {
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

// --- PATH traversal --------------------------------------------------------

function isWindowsPlatform(): boolean {
  return process.platform === "win32";
}

/** Platform extensions to try, including the empty suffix on POSIX. */
function pathExtensions(): string[] {
  return isWindowsPlatform()
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter((extension) => extension.length > 0)
    : [""];
}

function pathDirectories(): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((directory) => directory.length > 0);
}

/**
 * Candidate filenames for `command` in one directory. Windows installers may
 * leave both a bare launcher and a PATHEXT shim; the caller's preference
 * decides which is tried first.
 */
function candidatesIn(
  directory: string,
  command: string,
  extensions: readonly string[],
  includeBare: boolean,
  bareFirst: boolean,
): string[] {
  const bare = join(directory, command);
  const extended = extensions.map((extension) => join(directory, `${command}${extension}`));
  if (!includeBare) return extended;
  return bareFirst ? [bare, ...extended] : [...extended, bare];
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
  const extensions = pathExtensions();
  const windows = isWindowsPlatform();
  let problem: string | undefined;

  for (const directory of pathDirectories()) {
    let shimFound = false;
    for (const candidate of candidatesIn(directory, command, extensions, windows, false)) {
      if (!existsSync(candidate)) continue;
      if (isSpawnable(candidate)) {
        return { available: true, executable: candidate };
      }
      shimFound = true;
      problem ??= spawnProblem(command, candidate);
    }
    if (!windows || !shimFound) continue;
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
  if (isWindowsPlatform()) {
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

/**
 * Resolves a user/project backend the way the OS would, without launching it.
 * An absolute path is checked directly; a path with a separator is resolved by
 * `spawn` against the session cwd, which is unknown here; a bare name walks
 * PATH. A Windows shell shim is reported unavailable with the reason rather
 * than failing at spawn time.
 */
export function resolveCommand(command: string): CommandResolution {
  const check = (candidate: string): CommandResolution => {
    const reason = shellShimReason(command, candidate);
    return reason !== null ? { available: false, reason } : { available: true };
  };

  if (isAbsolute(command)) {
    if (!existsSync(command)) {
      return { available: false, reason: `command "${command}" was not found` };
    }
    return check(command);
  }
  // Do not guess: a relative path is resolved by spawn against the session cwd.
  if (command.includes("/") || command.includes("\\")) return { available: true };

  const extensions = pathExtensions();
  for (const directory of pathDirectories()) {
    for (const candidate of candidatesIn(directory, command, extensions, true, true)) {
      if (existsSync(candidate)) return check(candidate);
    }
  }
  return {
    available: false,
    reason: `command "${command}" was not found on PATH`,
  };
}

/** The reason a Windows `.cmd`/`.bat`/`.ps1` shim cannot be spawned directly. */
function shellShimReason(command: string, candidate: string): string | null {
  if (!isWindowsPlatform()) return null;
  const extension = extname(candidate).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat" && extension !== ".ps1") {
    return null;
  }
  return (
    `command "${command}" resolves to ${basename(candidate)}, a Windows shell ` +
    `shim that cannot be spawned directly; point the backend at the executable it wraps`
  );
}

/** The reason a candidate found by the spawn resolver cannot be launched. */
function spawnProblem(command: string, candidate: string): string {
  const shim = shellShimReason(command, candidate);
  if (shim !== null) return shim;
  if (!isWindowsPlatform()) {
    return `command "${command}" resolves to ${basename(candidate)}, which is not executable`;
  }
  return (
    `command "${command}" resolves to ${basename(candidate)}, which is not a ` +
    `Windows executable (.exe or .com)`
  );
}
