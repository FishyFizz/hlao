export function hasCommandHelp(command: string): boolean {
  return COMMAND_HELP_NAMES.has(command) || command === "help";
}

/** Nearest command names for a mistyped command, best first. */
export function suggestCommands(input: string, limit = 3): string[] {
  const typed = input.toLowerCase();
  const names = [...COMMAND_HELP_NAMES, "help", "version"];
  return names
    .map((name) => ({
      name,
      distance: editDistance(typed, name),
      prefix: name.startsWith(typed),
    }))
    .filter(({ distance, prefix }) => prefix || distance <= 2)
    .sort(
      (left, right) =>
        left.distance - right.distance || left.name.localeCompare(right.name),
    )
    .slice(0, limit)
    .map(({ name }) => name);
}

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) =>
      row === 0 ? column : column === 0 ? row : 0,
    ),
  );
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution =
        table[row - 1]![column - 1]! +
        (left[row - 1] === right[column - 1] ? 0 : 1);
      table[row]![column] = Math.min(
        table[row - 1]![column]! + 1,
        table[row]![column - 1]! + 1,
        substitution,
      );
    }
  }
  return table[rows - 1]![columns - 1]!;
}

const COMMAND_HELP_NAMES = new Set([
  "spawn",
  "adopt",
  "provider",
  "children",
  "send",
  "read",
  "export",
  "wait",
  "get",
  "find",
  "usage",
  "watch",
  "list",
  "cancel",
  "close",
  "permit",
  "elicit",
  "mode",
  "option",
  "queue",
  "rename",
  "agents",
  "status",
  "logs",
  "config",
  "reload",
  "doctor",
  "whoami",
  "skill",
  "down",
]);
