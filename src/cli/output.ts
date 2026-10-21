/**
 * Process output and the optional JSON envelope. The envelope state is set
 * once before dispatch, so errors and help/version honor the flag too.
 */

let jsonEnvelope = false;
let jsonCommand = "hlao";

/** Records the command name for `--json=envelope`. */
export function configureJsonEnvelope(command: string): void {
  jsonCommand = command;
}

/** Set before dispatch so even errors and help/version honor the flag. */
export function setJsonEnvelope(enabled: boolean): void {
  jsonEnvelope = enabled;
}

export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function writeJson(value: unknown): void {
  const payload = jsonEnvelope
    ? { ok: true, command: jsonCommand, result: value }
    : value;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** One JSON document per line, envelope-aware (watch/follow streams). */
export function writeJsonLine(value: unknown): void {
  const payload = jsonEnvelope
    ? { ok: true, command: jsonCommand, result: value }
    : value;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Error output for the envelope mode; the default error shape is unchanged. */
export function writeJsonFailure(error: {
  code: string;
  message: string;
  details?: unknown;
}): void {
  const payload = jsonEnvelope
    ? { ok: false, command: jsonCommand, error }
    : { ok: false, error };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
