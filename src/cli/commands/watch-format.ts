import type { EventType, EventView } from "../../protocol.js";
import { sanitize, type Style } from "../render.js";

export const MAX_IDS_PER_SUBSCRIPTION = 100;
const SUMMARY_CHARS = 120;

export function chunkIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += MAX_IDS_PER_SUBSCRIPTION) {
    chunks.push(ids.slice(index, index + MAX_IDS_PER_SUBSCRIPTION));
  }
  return chunks;
}

export function typeLabel(type: EventType, style: Style): string {
  const padded = type.padEnd(22);
  if (type.startsWith("permission") || type === "elicitation.requested") {
    return style.magenta(padded);
  }
  if (type === "error" || type === "stderr") return style.red(padded);
  if (type.startsWith("prompt") || type.startsWith("turn")) return style.cyan(padded);
  if (type.startsWith("tool")) return style.yellow(padded);
  return padded;
}

export function eventSummary(event: EventView): string {
  const data = event.data ?? {};
  const preferred = [
    "text",
    "title",
    "message",
    "content",
    "name",
    "reason",
    "status",
    "command",
  ].find((key) => typeof data[key] === "string" && (data[key] as string).length > 0);
  let text: string;
  if (preferred !== undefined) {
    text = data[preferred] as string;
  } else {
    text = safeJson(data);
  }
  text = sanitize(text).replace(/\s+/g, " ").trim();
  return truncate(text, SUMMARY_CHARS);
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "--:--:--";
  return date.toTimeString().slice(0, 8);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
