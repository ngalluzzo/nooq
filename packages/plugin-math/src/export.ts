/**
 * $$-fenced math: `$$\n<latex>\n$$` both directions — the export engine's
 * companion parser entry joins importMarkdown's fence handling.
 */
import type { BlockFormatter } from "@nooq/plugins";

/** The math block exports as a display-math fence; the source verbatim. */
export const mathFormatter: BlockFormatter = (block, { text }) => `$$\n${text()}\n$$`;

export const mathFormatters: Readonly<Record<string, BlockFormatter>> = Object.freeze({ "nooq.math/v1": mathFormatter });
