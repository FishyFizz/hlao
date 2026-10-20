import {
  booleanOption,
  expectPositionals,
  parseArgs,
  usageError,
} from "../args.js";
import { COMMON, contextFrom, out, writeJson } from "../context.js";
import { helpRequested } from "../help.js";
import {
  SKILL_VERSION,
  ensureHomeSkill,
  packagedSkillPath,
  skillText,
} from "../../skill.js";

/**
 * Print the agent-facing skill. This is deliberately local and does not start
 * a supervisor; a spawned session can always run `hlao skill` even when its
 * `HLAO_SKILL` path is the home copy.
 */
export async function cmdSkill(args: string[]): Promise<number> {
  const parsed = parseArgs(args, [...COMMON, { name: "path", type: "boolean" }]);
  if (helpRequested(parsed, "skill")) return 0;
  expectPositionals(parsed, "skill", 0, 1);
  if (
    parsed.positionals.length === 1 &&
    parsed.positionals[0] !== "path"
  ) {
    throw usageError('skill takes no arguments (or "path")');
  }

  const ctx = contextFrom(parsed);
  const homePath = ensureHomeSkill(ctx.home);
  const text = skillText();

  if (ctx.json) {
    writeJson({
      name: "hlao",
      version: SKILL_VERSION,
      path: homePath,
      packagedPath: packagedSkillPath(),
      text,
    });
    return 0;
  }
  if (
    booleanOption(parsed, "path") === true ||
    parsed.positionals[0] === "path"
  ) {
    out(homePath);
    return 0;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}
