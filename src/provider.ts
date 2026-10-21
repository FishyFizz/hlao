import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  type AgentCapabilities,
  type ClientConnection,
  type ListSessionsResponse,
} from "@agentclientprotocol/sdk";

import { HLAO_CLIENT_CAPABILITIES } from "./acp.js";
import type { BackendManifest } from "./config.js";
import { HlaoError, describeError } from "./errors.js";
import { ACP_PROTOCOL_VERSION } from "./protocol.js";
import { withTimeout } from "./session/async.js";
import { killProcessTree, waitForExit } from "./session/process.js";
import { VERSION } from "./version.js";

/** One row of the provider's own session catalog. */
export interface ProviderSessionRow {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
}

export interface ProviderSessionCatalog {
  sessions: ProviderSessionRow[];
  nextCursor: string | null;
  agentName: string | null;
  agentVersion: string | null;
  capabilities: {
    list: boolean;
    load: boolean;
    fork: boolean;
  };
}

export interface ProviderSessionOptions {
  backend: BackendManifest;
  /** Absolute cwd filter; omit to read the provider's catalog across cwds. */
  cwd?: string;
  cursor?: string;
  timeoutMs: number;
  /** The adapter process's cwd. Defaults to the filter cwd or process.cwd(). */
  processCwd?: string;
  /** Aborts the probe and kills its adapter (client disconnect or shutdown). */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

const MAX_STDERR = 4_096;

/**
 * Read the provider's session catalog through ACP `session/list`.
 *
 * This starts a short-lived adapter process rather than creating an HLAO
 * session: the catalog belongs to the provider, and a read must not appear in
 * the live table or create a provider conversation. The process is always
 * killed before this function settles.
 */
export async function listProviderSessions(
  options: ProviderSessionOptions,
): Promise<ProviderSessionCatalog> {
  const { backend, cwd, cursor, timeoutMs } = options;
  if (isAborted(options.signal)) {
    throw new HlaoError("bad_request", "provider session listing aborted");
  }
  options.log?.(
    `provider sessions: ${backend.name} (${cwd ?? "all cwds"})`,
  );

  const child = spawn(backend.command, backend.args, {
    cwd: options.processCwd ?? cwd ?? process.cwd(),
    env: adapterEnv(backend),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // On POSIX the adapter leads its own process group so a probe can be
    // reaped together with anything it started.
    detached: process.platform !== "win32",
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR);
  });

  // A disconnected client or a stopping supervisor must not leave a probe
  // adapter behind, especially on Windows.
  const onAbort = (): void => killProcessTree(child);
  if (isAborted(options.signal)) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const spawnFailure = new Promise<never>((_, reject) => {
    child.once("error", (error) => {
      reject(
        new HlaoError(
          "spawn_failed",
          `cannot start ${backend.name} to list provider sessions: ${describeError(error)}`,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      reject(
        new HlaoError(
          "spawn_failed",
          `${backend.name} exited while listing provider sessions (${signal ?? code ?? "unknown"})${stderrSuffix(stderr)}`,
          { stderr },
        ),
      );
    });
  });
  // The exit listener can fire during intentional cleanup after success.
  spawnFailure.catch(() => {});

  let connection: ClientConnection | null = null;
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.once("spawn", () => resolve())),
      spawnFailure,
    ]);
    if (isAborted(options.signal)) {
      throw new HlaoError("bad_request", "provider session listing aborted");
    }

    if (!child.stdin || !child.stdout) {
      throw new HlaoError(
        "spawn_failed",
        `${backend.name} adapter stdio is unavailable`,
      );
    }

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const app = client({ name: "hlao" });
    connection = app.connect(stream);

    const init = await withTimeout(
      connection.agent.request<{
        protocolVersion: number;
        agentCapabilities?: AgentCapabilities;
        agentInfo?: { name?: string; version?: string } | null;
      }>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: HLAO_CLIENT_CAPABILITIES,
        clientInfo: { name: "hlao", version: VERSION },
      }),
      timeoutMs,
      "ACP initialize",
    );

    if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new HlaoError(
        "spawn_failed",
        `${backend.name} speaks ACP v${init.protocolVersion}; HLAO requires v${ACP_PROTOCOL_VERSION}`,
      );
    }

    const capabilities = init.agentCapabilities ?? {};
    const listable =
      capabilities.sessionCapabilities?.list !== undefined &&
      capabilities.sessionCapabilities?.list !== null;
    if (!listable) {
      throw new HlaoError(
        "bad_request",
        `${backend.name} does not advertise ACP session/list; provider sessions cannot be listed`,
      );
    }

    const listed = await withTimeout(
      connection.agent.request<ListSessionsResponse>("session/list", {
        cwd: cwd ?? null,
        cursor: cursor ?? null,
      }),
      timeoutMs,
      "ACP session/list",
    );

    const sessions = normalizeRows(listed.sessions);
    options.log?.(
      `provider sessions: ${backend.name} returned ${sessions.length} row${
        sessions.length === 1 ? "" : "s"
      }`,
    );
    return {
      sessions,
      nextCursor:
        typeof listed.nextCursor === "string" && listed.nextCursor.length > 0
          ? listed.nextCursor
          : null,
      agentName:
        typeof init.agentInfo?.name === "string" ? init.agentInfo.name : null,
      agentVersion:
        typeof init.agentInfo?.version === "string"
          ? init.agentInfo.version
          : null,
      capabilities: {
        list: true,
        load: Boolean(capabilities.loadSession),
        fork:
          capabilities.sessionCapabilities?.fork !== undefined &&
          capabilities.sessionCapabilities?.fork !== null,
      },
    };
  } catch (error) {
    if (error instanceof HlaoError) {
      if (error.code === "bad_request") throw error;
      if (error.code === "timeout") {
        throw new HlaoError(
          "spawn_failed",
          `${backend.name} provider session listing timed out${stderrSuffix(stderr)}`,
          { stderr },
        );
      }
      throw error;
    }
    throw new HlaoError(
      "spawn_failed",
      `${backend.name} provider session listing failed: ${describeError(error)}${stderrSuffix(stderr)}`,
      { stderr },
    );
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try {
      connection?.close();
    } catch {
      // The connection may already be gone.
    }
    killProcessTree(child);
    await waitForExit(child, 500);
  }
}

function adapterEnv(backend: BackendManifest): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // A probe is not an HLAO session. Never leak a caller's session identity
    // into an adapter that is only reading the provider's catalog.
    if (!key.startsWith("HLAO_")) base[key] = value;
  }
  return { ...base, ...backend.env };
}

function normalizeRows(raw: ListSessionsResponse["sessions"]): ProviderSessionRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: ProviderSessionRow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.sessionId !== "string" ||
      record.sessionId.length === 0 ||
      typeof record.cwd !== "string" ||
      record.cwd.length === 0
    ) {
      continue;
    }
    const title =
      typeof record.title === "string" && record.title.trim().length > 0
        ? record.title
        : null;
    const updatedAt =
      typeof record.updatedAt === "string" &&
      Number.isFinite(Date.parse(record.updatedAt))
        ? new Date(record.updatedAt).toISOString()
        : null;
    rows.push({
      sessionId: record.sessionId,
      cwd: record.cwd,
      title,
      updatedAt,
    });
  }
  return rows;
}

function stderrSuffix(stderr: string): string {
  const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-5).join("\n");
  return tail.length > 0 ? ` — ${tail}` : "";
}

/** Read the signal through a call so TypeScript cannot narrow a mutable flag. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}
