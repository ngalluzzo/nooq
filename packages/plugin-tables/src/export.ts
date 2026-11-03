/**
 * Markdown pipes both directions: | a | b | rows, a --- separator after the
 * first row (markdown's grammar demands one; we carry no header semantics,
 * so the import skips separators rather than inventing meaning).
 */
import type { BlockFormatter } from "@nooq/plugins";

export const tableFormatter: BlockFormatter = (block, { children }) => {
  // children arrive as rows (each a pipe line), joined by the walk's blank line;
  // a markdown table wants consecutive lines and a separator after row one.
  const rows = children.split("\n").filter(line => line.trim() !== "");
  if (rows.length === 0) return "";
  return [rows[0]!, "| --- | --- |", ...rows.slice(1)].join("\n");
};

export const rowFormatter: BlockFormatter = (block, { children }) => {
  const cells = children.split("\n").filter(line => line.trim() !== "");
  return `| ${cells.map(cell => cell.trim() === "" ? " " : cell).join(" | ")} |`;
};

export const cellFormatter: BlockFormatter = (block, { text }) => text();

export const tablesFormatters: Readonly<Record<string, BlockFormatter>> = Object.freeze({
  "nooq.table/v1": tableFormatter,
  "nooq.table-row/v1": rowFormatter,
  "nooq.table-cell/v1": cellFormatter,
});

/** A markdown table row: | a | b | — false for the --- separator. */
export function isPipeRow(line: string): boolean {
  return /^\|.*\|$/.test(line.trim()) && !/^\|[\s:|-]+\|$/.test(line.trim());
}
