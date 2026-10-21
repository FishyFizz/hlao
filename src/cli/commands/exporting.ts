import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SupervisorConnection } from "../../client.js";
import { HlaoError } from "../../errors.js";
import type {
  EventView,
  ListResult,
  ReadResult,
  SessionView,
} from "../../protocol.js";

const EXPORT_PAGE_SIZE = 1_000;

export interface SessionExport {
  session: SessionView;
  events: EventView[];
  earliestRetainedSeq: number;
  lastSeq: number;
  count: number;
  truncated: boolean;
}

export interface ExportOptions {
  since?: number;
  raw: boolean;
}

/** Read a session's full retained history, page by page. */
export async function exportSession(
  conn: SupervisorConnection,
  sessionId: string,
  options: ExportOptions,
): Promise<SessionExport> {
  let since = options.since ?? 0;
  const events: EventView[] = [];
  let session: SessionView | null = null;
  let earliestRetainedSeq = 0;
  let lastSeq = 0;
  let truncated = false;

  for (;;) {
    const page = await conn.request<ReadResult>("sessions.read", {
      sessionId,
      since,
      limit: EXPORT_PAGE_SIZE,
      raw: options.raw,
    });
    session = page.session;
    earliestRetainedSeq = page.earliestRetainedSeq;
    lastSeq = page.lastSeq;
    truncated = truncated || page.truncated;
    events.push(...page.events);
    if (!page.hasMore) break;
    const next = page.nextSeq;
    if (next <= since) {
      throw new HlaoError("internal", "export cursor did not advance");
    }
    since = next;
  }

  if (session === null) {
    throw new HlaoError("internal", "export returned no session");
  }
  return {
    session,
    events,
    earliestRetainedSeq,
    lastSeq,
    count: events.length,
    truncated,
  };
}

export interface ExportManifestEntry {
  sessionId: string;
  /** The durable provider handle; the only id that can reopen this conversation. */
  agentSessionId: string | null;
  name: string | null;
  backend: string;
  cwd: string;
  status: string;
  file: string;
  count: number;
  truncated: boolean;
  earliestRetainedSeq: number;
  error?: string;
}

export interface ExportManifest {
  exportedAt: string;
  sessions: ExportManifestEntry[];
  failures: number;
}

export interface ExportAllOptions extends ExportOptions {
  jsonl: boolean;
}

function exportFileName(sessionId: string, jsonl: boolean): string {
  return `${sessionId}.${jsonl ? "jsonl" : "json"}`;
}

/**
 * Refuse to mix a new export into an existing one. Export is the recovery path,
 * so silently overwriting yesterday's backup is worse than failing.
 */
export function prepareExportDir(
  outDir: string,
  sessionIds: string[],
  jsonl: boolean,
): void {
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (error) {
    throw new HlaoError(
      "bad_request",
      `cannot create ${outDir}: ${(error as Error).message}`,
    );
  }
  const files = [
    ...sessionIds.map((id) => exportFileName(id, jsonl)),
    "manifest.json",
  ];
  const existing = files.filter((file) => existsSync(join(outDir, file)));
  if (existing.length > 0) {
    throw new HlaoError(
      "bad_request",
      `refusing to overwrite ${existing.slice(0, 3).join(", ")}${existing.length > 3 ? ` and ${existing.length - 3} more` : ""} in ${outDir}; choose an empty directory`,
    );
  }
}

/**
 * Export every session in the instance. Per-session failures are recorded in
 * the manifest and do not stop the remaining sessions; `failures` tells a
 * caller (notably `down --export`) whether the backup is complete.
 */
export async function exportAll(
  conn: SupervisorConnection,
  outDir: string,
  options: ExportAllOptions,
): Promise<ExportManifest> {
  const list = await conn.request<ListResult>("sessions.list", {
    includeClosed: true,
  });
  const ids = list.sessions.map((session) => session.id);
  prepareExportDir(outDir, ids, options.jsonl);

  const entries: ExportManifestEntry[] = [];
  let failures = 0;
  for (const view of list.sessions) {
    const file = exportFileName(view.id, options.jsonl);
    try {
      const payload = await exportSession(conn, view.id, options);
      const body = options.jsonl
        ? `${payload.events.map((event) => JSON.stringify(event)).join("\n")}${
            payload.events.length > 0 ? "\n" : ""
          }`
        : `${JSON.stringify(
            {
              session: payload.session,
              events: payload.events,
              earliestRetainedSeq: payload.earliestRetainedSeq,
              lastSeq: payload.lastSeq,
              count: payload.count,
              truncated: payload.truncated,
            },
            null,
            2,
          )}\n`;
      writeFileSync(join(outDir, file), body);
      entries.push({
        sessionId: view.id,
        agentSessionId: view.agentSessionId,
        name: view.name,
        backend: view.backend,
        cwd: view.cwd,
        status: view.status,
        file,
        count: payload.count,
        truncated: payload.truncated,
        earliestRetainedSeq: payload.earliestRetainedSeq,
      });
    } catch (error) {
      failures += 1;
      entries.push({
        sessionId: view.id,
        agentSessionId: view.agentSessionId,
        name: view.name,
        backend: view.backend,
        cwd: view.cwd,
        status: view.status,
        file,
        count: 0,
        truncated: false,
        earliestRetainedSeq: 0,
        error: (error as Error).message,
      });
    }
  }

  const manifest: ExportManifest = {
    exportedAt: new Date().toISOString(),
    sessions: entries,
    failures,
  };
  writeFileSync(
    join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
