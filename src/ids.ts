import { randomInt } from "node:crypto";

/** Crockford-style alphabet: digits plus letters with i, l, o, u removed. */
export const SESSION_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const SESSION_ID_LENGTH = 6;

const SESSION_ID_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]{6}$/;

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/**
 * Generates a short handle. `exists` is a collision check supplied by the caller
 * (the supervisor's live table); collisions are retried a bounded number of times.
 */
export function generateSessionId(exists: (id: string) => boolean = () => false): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let id = "";
    for (let index = 0; index < SESSION_ID_LENGTH; index += 1) {
      id += SESSION_ID_ALPHABET[randomInt(SESSION_ID_ALPHABET.length)]!;
    }
    if (!exists(id)) return id;
  }
  throw new Error("could not allocate a session id after 100 attempts");
}

/** A stable prompt identity. Generated when the caller does not supply one. */
export function generateMessageId(): string {
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += SESSION_ID_ALPHABET[randomInt(SESSION_ID_ALPHABET.length)]!;
  }
  return `msg-${suffix}`;
}

/** True when `token` is a prefix of `id`, or equal to it. */
export function isIdPrefix(token: string, id: string): boolean {
  return token.length > 0 && id.startsWith(token);
}
