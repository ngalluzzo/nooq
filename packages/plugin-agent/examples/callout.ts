import { defineBlock, defineCommand, definePlugin } from "@nooq/plugins";

const TONES: readonly string[] = ["info", "warning", "success"];

const block = defineBlock({
  type: "seed.callout/v1",
  label: "Callout",
  text: "inline",
  create: () => ({
    fields: { tone: "info" },
    text: { s: "", marks: [] },
  }),
  diagnose: (target) => {
    const tone = target.fields.tone;
    if (!TONES.includes(tone as string)) {
      return [
        {
          field: "tone",
          message: "Callout tone must be one of 'info', 'warning', or 'success'.",
        },
      ];
    }
    return [];
  },
});

const command0 = defineCommand<{ block: string }>({
  id: "seed.callout.cycle-tone",
  label: "Cycle callout tone",
  validateArgs: (input): input is { block: string } =>
    typeof input === "object" &&
    input !== null &&
    "block" in input &&
    typeof (input as { block: unknown }).block === "string",
  prepare: (ctx, args) => {
    const target = ctx.snapshot.blocks[args.block];
    if (!ctx.isAlive(args.block) || !target || target.type !== "seed.callout/v1") {
      return { status: "not-applicable" };
    }
    const index = TONES.indexOf(target.fields.tone as string);
    if (index === -1) {
      return { status: "not-applicable" };
    }
    return {
      status: "ready",
      intent: "cycle-callout-tone",
      ops: [
        {
          op: "setField",
          block: args.block,
          key: "tone",
          value: TONES[(index + 1) % TONES.length],
        },
      ],
    };
  },
});

export default definePlugin({
  id: "seed.callouts",
  version: "0.1.0",
  apiVersion: 1,
  contributes: { blocks: [block], commands: [command0] },
});
