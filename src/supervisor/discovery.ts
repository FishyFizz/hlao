import { mergeBackends, toAgentView, type HlaoConfig } from "../config.js";
import { HlaoError } from "../errors.js";
import { readSpawnReceipts } from "../ledger.js";
import type {
  BackendsListResult,
  ProviderSessionView,
  ProviderSessionsParams,
  ProviderSessionsResult,
  RecoveryReceiptView,
  RecoveryReceiptsParams,
  RecoveryReceiptsResult,
} from "../protocol.js";
import { listProviderSessions } from "../provider.js";
import type { Session } from "../session.js";

/**
 * Instance-level reads: what backends exist, what the provider's own catalog
 * holds, and what historical spawn receipts were recorded. None of these
 * mutate the live session table; discovery joins it, it does not own it.
 */

export function listBackends(
  config: HlaoConfig,
  cwd: string,
): BackendsListResult {
  const merged = mergeBackends(config.backends, cwd);
  return {
    backends: Object.values(merged)
      .map(toAgentView)
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function providerSessionCatalog(options: {
  config: HlaoConfig;
  sessions: ReadonlyMap<string, Session>;
  params: ProviderSessionsParams;
  /** The cwd used both to merge project backends and as the adapter's cwd. */
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  log: (line: string) => void;
}): Promise<ProviderSessionsResult> {
  const { config, sessions, params, cwd } = options;
  const merged = mergeBackends(config.backends, cwd);
  const backend = merged[params.backend];
  if (backend === undefined) {
    throw new HlaoError(
      "backend_not_found",
      `unknown backend "${params.backend}" — available: ${Object.keys(merged).sort().join(", ")}`,
    );
  }
  if (!backend.available) {
    throw new HlaoError(
      "backend_unavailable",
      `backend "${backend.name}" is unavailable: ${backend.unavailableReason ?? "unknown reason"}`,
    );
  }

  const catalog = await listProviderSessions({
    backend,
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    timeoutMs: options.timeoutMs,
    processCwd: cwd,
    signal: options.signal,
    log: options.log,
  });

  const live = [...sessions.values()].filter(
    (candidate) =>
      !candidate.isTerminal && candidate.backend === backend.name,
  );
  const rows: ProviderSessionView[] = catalog.sessions.map((row) => {
    const attached = live.find(
      (candidate) => candidate.view().agentSessionId === row.sessionId,
    );
    const view = attached?.view();
    return {
      sessionId: row.sessionId,
      cwd: row.cwd,
      title: row.title,
      updatedAt: row.updatedAt,
      attached: view !== undefined,
      hlaoSessionId: view?.id ?? null,
      hlaoName: view?.name ?? null,
      hlaoStatus: view?.status ?? null,
      loadable: catalog.capabilities.load,
      forkable: catalog.capabilities.fork,
    };
  });

  return {
    backend: backend.name,
    cwd: params.cwd ?? null,
    agentName: catalog.agentName,
    agentVersion: catalog.agentVersion,
    sessions: rows,
    nextCursor: catalog.nextCursor,
  };
}

/**
 * Historical spawn receipts, live-joined for convenience. The ledger is the
 * authority on what was attached; the live table answers only whether a
 * provider id is attached now. Nothing here is written back.
 */
export function recoveryReceipts(
  home: string,
  sessions: ReadonlyMap<string, Session>,
  params: RecoveryReceiptsParams,
): RecoveryReceiptsResult {
  const liveByProvider = new Map<string, Session>();
  for (const session of sessions.values()) {
    if (session.isTerminal) continue;
    const view = session.view();
    if (view.agentSessionId === null) continue;
    liveByProvider.set(view.agentSessionId, session);
  }

  const byChild = new Map<string, RecoveryReceiptView>();
  for (const receipt of readSpawnReceipts(home, params.parentProviderId)) {
    const key = `${receipt.backend}\u0000${receipt.childProviderId}`;
    const existing = byChild.get(key);
    if (existing !== undefined && existing.recordedAt >= receipt.at) continue;
    const child = liveByProvider.get(receipt.childProviderId);
    const childView =
      child !== undefined && child.backend === receipt.backend
        ? child.view()
        : null;
    const parent = liveByProvider.get(receipt.parentProviderId);
    const parentView = parent?.view() ?? null;
    byChild.set(key, {
      parentProviderId: receipt.parentProviderId,
      parentSessionId: receipt.parentSessionId,
      childProviderId: receipt.childProviderId,
      childSessionId: receipt.childSessionId,
      backend: receipt.backend,
      cwd: receipt.cwd,
      name: receipt.name,
      recordedAt: receipt.at,
      attached: childView !== null,
      hlaoSessionId: childView?.id ?? null,
      hlaoName: childView?.name ?? null,
      hlaoStatus: childView?.status ?? null,
      parentHlaoSessionId: parentView?.id ?? null,
      parentHlaoName: parentView?.name ?? null,
      parentHlaoStatus: parentView?.status ?? null,
    });
  }
  const receipts = [...byChild.values()].sort((left, right) =>
    right.recordedAt.localeCompare(left.recordedAt),
  );
  return { receipts };
}
