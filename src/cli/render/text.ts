import { formatDuration } from "../../time.js";

const ANSI_ESCAPE =
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// U+061C, U+200E/F, U+202A-E, U+2066-9: bidi overrides can reorder a terminal.
const BIDI_CHARS = /[؜‎‏‪-‮⁦-⁩]/g;

/** Agent-derived text is untrusted: never let it inject terminal control sequences. */
export function sanitize(value: string): string {
  return value
    .replace(ANSI_ESCAPE, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CHARS, "");
}

export function oneLine(value: unknown): string {
  return sanitize(String(value ?? ""))
    .replace(/[\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** The `from`/`by`/`createdBy` value exactly as the event carries it. */
export function actorName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = oneLine(value);
  return name.length > 0 ? name : null;
}

export function indent(text: string): string {
  return sanitize(text).replace(/\n/g, "\n  ");
}

export function truncateLeft(value: string, max: number): string {
  if (displayWidth(value) <= max) return value;
  return `…${takeWidth(value, Math.max(0, max - 1), true)}`;
}

export function truncateRight(value: string, max: number): string {
  if (displayWidth(value) <= max) return value;
  return `${takeWidth(value, Math.max(0, max - 1))}…`;
}

export function truncateMiddle(value: string, max: number): string {
  if (displayWidth(value) <= max) return value;
  const keep = Math.max(0, max - 1);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${takeWidth(value, head)}…${takeWidth(value, tail, true)}`;
}

export function pad(value: string, width: number): string {
  const missing = width - visibleLength(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** Columns occupied in a terminal: CJK and emoji are two, combining marks zero. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value.replace(ANSI_PATTERN, "")) {
    width += charWidth(char.codePointAt(0)!);
  }
  return width;
}

export function visibleLength(value: string): number {
  return displayWidth(value);
}

function takeWidth(value: string, max: number, fromEnd = false): string {
  let out = "";
  let width = 0;
  const chars = [...value];
  if (fromEnd) chars.reverse();
  for (const char of chars) {
    const charColumns = charWidth(char.codePointAt(0)!);
    if (width + charColumns > max) break;
    out = fromEnd ? char + out : out + char;
    width += charColumns;
  }
  return out;
}

function charWidth(codePoint: number): number {
  // Combining marks and zero-width characters occupy no column.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    codePoint === 0xfeff
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function formatAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const delta = Math.max(0, Date.now() - then);
  if (delta < 1_000) return "now";
  return `${formatDuration(delta)} ago`;
}

export function formatCreated(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 16).replace("T", " ")
    : "—";
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
