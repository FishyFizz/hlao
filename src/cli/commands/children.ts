import type { GetResult } from "../../protocol.js";
import { readSpawnReceipts, type SpawnReceipt } from "../../ledger.js";
import { spawnLedgerPath } from "../../paths.js";
import {
  booleanOption,
  expectPositionals,
  parseArgs,
  stringOption,
  usageError,
} from "../args.js";
import {
  COMMON,
  connect,
  contextFrom,
  out,
  writeJson,
} from "../context.js";
import { helpRequested } from "../help.js";
import { displayWidth, sanitize, type Style } from "../render.js";

export async function cmdChildren(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [
    ...COMMON,
    { name: "provider", type: "string", valueName: "ID" },
    { name: "self", type: "boolean" },
  ]);
  if (helpRequested(parsed, "children")) return 0;
  expectPositionals(parsed, "children", 0, 0);

  const ctx = contextFrom(parsed);
  const explicit = stringOption(parsed, "provider")?.trim();
  const self = booleanOption(parsed, "self") === true;
  if (explicit !== undefined && self) {
    throw usageError("children: pass --provider or --self, not both");
  }

  let parentProviderId = explicit;
  if (parentProviderId === undefined) {
    if (!ctx.callerSessionId) {
      throw usageError(
        "children needs --provider <provider-id>, or run it inside a session (--self)",
      );
    }
    const conn = await connect(ctx);
    const got = await conn.request<GetResult>("sessions.get", {
      sessionId: ctx.callerSessionId,
    });
    parentProviderId = got.session.agentSessionId ?? undefined;
    if (parentProviderId === undefined) {
      throw usageError(
        "this session reports no provider id; pass --provider <provider-id>",
      );
    }
  }

  const receipts = readSpawnReceipts(ctx.home, parentProviderId);
  if (ctx.json) {
    writeJson({
      parentProviderId,
      ledger: spawnLedgerPath(ctx.home),
      children: receipts,
    });
    return 0;
  }

  if (receipts.length === 0) {
    out(`no spawn receipts for parent provider ${sanitize(parentProviderId)}`);
    out(
      ctx.style.dim(
        "A receipt is written when a parent spawns or adopts a child on this instance. Historical receipts, not liveness.",
      ),
    );
    return 0;
  }

  out(renderReceipts(receipts, ctx.style));
  out(
    ctx.style.dim(
      `historical spawn receipts, not liveness · adopt with: hlao adopt <backend> <provider-id>`,
    ),
  );
  return 0;
}

function renderReceipts(receipts: SpawnReceipt[], style: Style): string {
  const rows = receipts.map((receipt) => ({
    provider: oneLine(receipt.childProviderId),
    backend: oneLine(receipt.backend),
    name: oneLine(receipt.name ?? "—"),
    cwd: oneLine(receipt.cwd),
    created: formatWhen(receipt.at),
  }));
  const headers = {
    provider: "PROVIDER",
    backend: "BACKEND",
    name: "NAME",
    cwd: "CWD",
    created: "CREATED",
  };
  const widths = {
    provider: Math.max(
      displayWidth(headers.provider),
      ...rows.map((row) => displayWidth(row.provider)),
    ),
    backend: Math.max(
      displayWidth(headers.backend),
      ...rows.map((row) => displayWidth(row.backend)),
    ),
    name: Math.max(
      displayWidth(headers.name),
      ...rows.map((row) => displayWidth(row.name)),
    ),
    cwd: Math.min(
      48,
      Math.max(
        displayWidth(headers.cwd),
        ...rows.map((row) => displayWidth(row.cwd)),
      ),
    ),
  };
  const format = (row: {
    provider: string;
    backend: string;
    name: string;
    cwd: string;
    created: string;
  }): string =>
    [
      pad(row.provider, widths.provider),
      pad(row.backend, widths.backend),
      pad(row.name, widths.name),
      pad(clip(row.cwd, widths.cwd), widths.cwd),
      row.created,
    ].join("  ");
  return [
    style.dim(format(headers)),
    ...rows.map((row) => format(row)),
  ].join("\n");
}

function oneLine(value: string): string {
  return sanitize(value).replace(/\s+/g, " ").trim();
}

function pad(value: string, width: number): string {
  const missing = width - displayWidth(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
}

function clip(value: string, width: number): string {
  const one = value.replace(/\s+/g, " ").trim();
  if (displayWidth(one) <= width) return one;
  let out = "";
  for (const char of one) {
    if (displayWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}

function formatWhen(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 16).replace("T", " ")
    : "—";
}

