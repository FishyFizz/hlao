import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HlaoError } from "./errors.js";
import { VERSION } from "./version.js";

/** The skill is versioned with the package; this is what sessions see. */
export const SKILL_VERSION = VERSION;

const SKILL_RELATIVE = join("skills", "hlao", "SKILL.md");

/** `src/skill.ts` and `dist/skill.js` both sit one level below the package root. */
export function packagedSkillPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", SKILL_RELATIVE);
}

export function skillText(): string {
  try {
    return readFileSync(packagedSkillPath(), "utf8");
  } catch (error) {
    throw new HlaoError(
      "internal",
      `cannot read the packaged HLAO skill: ${(error as Error).message}`,
    );
  }
}

/** The stable path a spawned session is told about. */
export function homeSkillPath(home: string): string {
  return join(home, "skills", "hlao", "SKILL.md");
}

/**
 * Write the packaged skill into the runtime home when it is missing or stale.
 * The home copy is a snapshot, not user configuration.
 */
export function ensureHomeSkill(home: string): string {
  const target = homeSkillPath(home);
  const text = skillText();
  let current: string | null = null;
  try {
    current = existsSync(target) ? readFileSync(target, "utf8") : null;
  } catch {
    current = null;
  }
  if (current !== text) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return target;
}
