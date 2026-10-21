import type { Style } from "./style.js";
import { displayWidth, pad, truncateRight, visibleLength } from "./text.js";

export function renderTable(
  headers: string[],
  rows: string[][],
  style: Style,
): string {
  const widths = headers.map((header, column) => {
    let width = header.length;
    for (const row of rows) {
      width = Math.max(width, visibleLength(row[column] ?? ""));
    }
    return width;
  });

  const headerLine = headers
    .map((header, column) => style.dim(pad(header, widths[column]!)))
    .join("  ");
  const body = rows
    .map((row) =>
      row
        .map((cell, column) => pad(cell ?? "", widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
  return `${headerLine}\n${body}`;
}

export interface FitTableOptions {
  /** Column keys in display order. */
  columns: string[];
  rows: string[][];
  width: number;
  /** Keys dropped, in order, while the table is too wide. */
  dropOrder: readonly string[];
  /** Keys whose cells may be truncated to fit. */
  shrinkable: readonly string[];
  /**
   * Shrink these keys in order, taking the first that is present, instead of
   * the widest flexible column. Tables with one structurally important column
   * (a command line) use this to keep its layout predictable.
   */
  shrinkPriority?: readonly string[];
  /** The header text for a key. Identity when the keys are the headers. */
  headerOf?: (column: string) => string;
}

/**
 * Drop optional columns, then shrink the widest flexible column, until the
 * table fits `width`. Shared by every table renderer; the drop order and the
 * shrinkable set are the only table-specific policy.
 */
export function fitTable(options: FitTableOptions): {
  columns: string[];
  rows: string[][];
} {
  const headerOf = options.headerOf ?? ((column: string) => column);
  let columns = [...options.columns];
  let rows = options.rows.map((row) => [...row]);

  const totalWidth = (): number => {
    const widths = columns.map((column, index) => {
      let value = displayWidth(headerOf(column));
      for (const row of rows) {
        value = Math.max(value, displayWidth(row[index] ?? ""));
      }
      return value;
    });
    return widths.reduce((sum, value) => sum + value, 0) +
      2 * Math.max(0, columns.length - 1);
  };

  for (const name of options.dropOrder) {
    if (totalWidth() <= options.width) break;
    const index = columns.indexOf(name);
    if (index === -1) continue;
    columns = columns.filter((_, column) => column !== index);
    rows = rows.map((row) => row.filter((_, column) => column !== index));
  }

  const widthOf = (column: number): number => {
    const key = columns[column]!;
    let value = displayWidth(headerOf(key));
    for (const row of rows) {
      value = Math.max(value, displayWidth(row[column] ?? ""));
    }
    return value;
  };

  // Shrink a flexible column that is still wider than its header. Keep the
  // shrink loop bounded so a pathological width cannot spin.
  for (let guard = 0; guard < 500 && totalWidth() > options.width; guard += 1) {
    let best = -1;
    let bestWidth = 0;
    if (options.shrinkPriority !== undefined) {
      const key = options.shrinkPriority.find((name) => columns.includes(name));
      if (key === undefined) break;
      best = columns.indexOf(key);
      bestWidth = widthOf(best);
      if (bestWidth <= 8) break;
    } else {
      for (let column = 0; column < columns.length; column += 1) {
        const key = columns[column]!;
        if (!options.shrinkable.includes(key)) continue;
        // Shaving a cell that contains an ANSI escape would cut through it.
        if (rows.some((row) => (row[column] ?? "").includes("\u001b"))) {
          continue;
        }
        const columnWidth = widthOf(column);
        if (columnWidth > bestWidth && columnWidth > 8) {
          best = column;
          bestWidth = columnWidth;
        }
      }
      if (best === -1) break;
    }
    const target = Math.max(8, bestWidth - (totalWidth() - options.width));
    rows = rows.map((row) => {
      const next = [...row];
      next[best] = truncateRight(next[best] ?? "", target);
      return next;
    });
  }

  return { columns, rows };
}
