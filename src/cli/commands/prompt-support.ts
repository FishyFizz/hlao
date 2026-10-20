import { out } from "../context.js";
import { sanitize } from "../render.js";

/** A timed-out turn may have produced text; show a bounded prefix of it. */
const PARTIAL_TEXT_LIMIT = 2_000;

export function printPartialText(text: string | undefined): void {
  if (text === undefined || text.trim().length === 0) return;
  const clean = sanitize(text).trimEnd();
  out(
    clean.length > PARTIAL_TEXT_LIMIT
      ? `${clean.slice(0, PARTIAL_TEXT_LIMIT)}…`
      : clean,
  );
}
