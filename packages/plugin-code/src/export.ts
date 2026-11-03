/**
 * Fenced export/import for code blocks: ```lang opens, the block's text
 * verbatim inside, ``` closes. The parser side lives here too (importMarkdown
 * extension) so the round trip is one module's responsibility.
 */
import type { Block } from "@nooq/core";
import type { BlockFormatter } from "@nooq/plugins";

/** ``` lang fences; inner text verbatim — never re-interpreted. */
export const codeFormatter: BlockFormatter = (block, { text }) => {
  const lang = typeof block.fields.lang === "string" && block.fields.lang !== "" ? block.fields.lang : "";
  return `\`\`\`${lang}\n${text()}\n\`\`\``;
};

/** A fence line: ``` alone closes; ```lang opens with that info string. */
export function fenceOf(line: string): { open: true; lang: string } | { open: false } | null {
  if (!line.startsWith("```")) return null;
  const info = line.slice(3).trim();
  if (info === "") return { open: false };
  return { open: true, lang: info };
}

/** The plugin's formatters for host composition (exportMarkdown options). */
export const codeFormatters: Readonly<Record<string, BlockFormatter>> = Object.freeze({ "nooq.code/v1": codeFormatter });
