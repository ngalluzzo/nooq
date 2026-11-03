/** ```mermaid fences: the source verbatim, the standard markdown extension. */
import type { BlockFormatter } from "@nooq/plugins";

export const diagramFormatter: BlockFormatter = (block, { text }) => `\`\`\`mermaid\n${text()}\n\`\`\``;

export const diagramFormatters: Readonly<Record<string, BlockFormatter>> = Object.freeze({ "nooq.diagram/v1": diagramFormatter });
