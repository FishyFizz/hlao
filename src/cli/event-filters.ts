import type { EventType } from "../protocol.js";
import { EVENT_TYPES } from "../protocol.js";
import {
  booleanOption,
  multipleOption,
  stringOption,
  usageError,
  type ParsedArgs,
} from "./args.js";

/** Validate repeated `--type` values against the wire's event types. */
export function parseEventTypes(parsed: ParsedArgs): EventType[] {
  const types = multipleOption(parsed, "type");
  for (const type of types) {
    if (!(EVENT_TYPES as readonly string[]).includes(type)) {
      throw usageError(
        `unknown event type "${type}" — known types: ${EVENT_TYPES.join(", ")}`,
      );
    }
  }
  return types as EventType[];
}

/** The shared `--grep` / `--regex` pair. */
export function parseGrepFilter(parsed: ParsedArgs): {
  grep: string | undefined;
  regex: boolean;
} {
  const grep = stringOption(parsed, "grep");
  if (grep === "") throw usageError("--grep needs text");
  const regex = booleanOption(parsed, "regex") === true;
  if (regex && grep === undefined) {
    throw usageError("--regex requires --grep");
  }
  return { grep, regex };
}
