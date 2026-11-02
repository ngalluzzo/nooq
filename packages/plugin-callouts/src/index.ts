import { defineBlockSchema, field, definePlugin, cycleFieldCommand, insertBlockCommand, quoteLines, type BlockFormatter } from "@nooq/plugins";

export const callout = defineBlockSchema({
  type: "nooq.callout/v1", label: "Callout", text: "inline",
  fields: { tone: field.enum(["info", "warning", "success"], "info") },
});

/** GitHub alert markers by tone; an unfamiliar stored tone degrades to [!NOTE]. */
const ALERTS: Readonly<Record<string, string>> = { info: "NOTE", warning: "WARNING", success: "TIP" };

/**
 * The callout as a GitHub alert: the tone picks the marker (`info` → NOTE,
 * `warning` → WARNING, `success` → TIP, anything else → NOTE), the block's
 * text is the alert body, and children follow inside the same quote after
 * a blank quoted line. Pass to `exportMarkdown` under
 * `formatters: { "nooq.callout/v1": calloutMarkdown }`.
 */
export const calloutMarkdown: BlockFormatter = (block, { text, children }) => {
  const tone = block.fields.tone;
  const alert = typeof tone === "string" ? ALERTS[tone] ?? "NOTE" : "NOTE";
  const body = quoteLines([text(), children].filter(part => part.length > 0).join("\n\n"));
  return body ? `> [!${alert}]\n${body}` : `> [!${alert}]`;
};
export const cycleTone = cycleFieldCommand(callout, "tone", { id: "nooq.callout.cycle-tone", label: "Cycle callout tone" });
export const insertCallout = insertBlockCommand(callout, { id: "nooq.callout.insert", label: "Insert callout" });
export const callouts = definePlugin({ id: "nooq.callouts", version: "1.1.0", apiVersion: 1,
  contributes: { blocks: [callout], commands: [insertCallout, cycleTone] },
});
