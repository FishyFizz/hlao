import { booleanOption, type ParsedArgs } from "./args.js";
import { commandHelp } from "./help/commands.js";
import { writeJson } from "./output.js";

export { commandHelp } from "./help/commands.js";
export { fullHelp } from "./help/overview.js";
export { hasCommandHelp, suggestCommands } from "./help/names.js";

export function helpRequested(parsed: ParsedArgs, command: string): boolean {
  if (booleanOption(parsed, "help") === true) {
    const text = commandHelp(command);
    if (booleanOption(parsed, "json") === true) {
      writeJson({ topic: command, help: text });
    } else {
      process.stdout.write(`${text}\n`);
    }
    return true;
  }
  return false;
}
