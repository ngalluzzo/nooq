import {
  definePlugin,
  defineBlockSchema,
  field,
  cycleFieldCommand,
  insertBlockCommand,
} from "@nooq/plugins";

const block = defineBlockSchema({
  type: "seed.callout/v1",
  label: "Callout",
  text: "inline",
  fields: {
    tone: field.enum(["info", "warning", "success"], "info"),
  },
});

const cycleTone = cycleFieldCommand(block, "tone", {
  id: "seed.callout.cycle-tone",
  label: "Cycle callout tone",
});

const insert = insertBlockCommand(block, {
  id: "seed.callout.insert",
  label: "Insert callout",
});

export default definePlugin({
  id: "seed.callouts",
  version: "0.1.0",
  apiVersion: 1,
  contributes: { blocks: [block], commands: [cycleTone, insert] },
});
