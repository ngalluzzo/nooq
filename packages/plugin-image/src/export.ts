/** The image's markdown: ![caption](src) — the caption is the block's text. */
import type { BlockFormatter } from "@nooq/plugins";

export const imageFormatter: BlockFormatter = (block, { text }) => {
  const src = typeof block.fields.src === "string" ? block.fields.src : "";
  const alt = typeof block.fields.alt === "string" && block.fields.alt !== "" ? block.fields.alt : text();
  return `![${alt.replace(/[\[\]]/g, "")}](${src})`;
};

export const imageFormatters: Readonly<Record<string, BlockFormatter>> = Object.freeze({ "nooq.image/v1": imageFormatter });
