import type { SessionStatus } from "../../protocol.js";

export interface Style {
  enabled: boolean;
  bold(value: string): string;
  dim(value: string): string;
  red(value: string): string;
  green(value: string): string;
  yellow(value: string): string;
  magenta(value: string): string;
  cyan(value: string): string;
  gray(value: string): string;
}

export function createStyle(enabled: boolean): Style {
  const wrap = (code: string) => (value: string) =>
    enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
  return {
    enabled,
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    magenta: wrap("35"),
    cyan: wrap("36"),
    gray: wrap("90"),
  };
}

export function colorsEnabled(json: boolean): boolean {
  return !json && process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

export function styleStatus(status: SessionStatus, style: Style): string {
  switch (status) {
    case "idle":
      return style.green(status);
    case "busy":
      return style.yellow(status);
    case "waiting_permission":
      return style.magenta(status);
    case "starting":
      return style.cyan(status);
    case "failed":
      return style.red(status);
    case "closed":
      return style.dim(status);
    default:
      return status;
  }
}
