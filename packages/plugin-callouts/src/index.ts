import { defineBlockSchema, field, definePlugin, cycleFieldCommand, insertBlockCommand } from "@nooq/plugins";

export const callout = defineBlockSchema({
  type: "nooq.callout/v1", label: "Callout", text: "inline",
  fields: { tone: field.enum(["info", "warning", "success"], "info") },
});
export const cycleTone = cycleFieldCommand(callout, "tone", { id: "nooq.callout.cycle-tone", label: "Cycle callout tone" });
export const insertCallout = insertBlockCommand(callout, { id: "nooq.callout.insert", label: "Insert callout" });
export const callouts = definePlugin({ id: "nooq.callouts", version: "1.1.0", apiVersion: 1,
  contributes: { blocks: [callout], commands: [insertCallout, cycleTone] },
});
