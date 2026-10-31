import { defineBlock, defineCommand, definePlugin, type Op } from "@nooq/plugins";

const tones = ["info", "warning", "success"] as const;
export const callout = defineBlock({ type: "nooq.callout/v1", label: "Callout", text: "inline",
  create: () => ({ fields: { tone: "info" }, text: { s: "", marks: [] } }),
  diagnose: block => tones.some(tone => tone === block.fields.tone) ? [] : [{ field: "tone", message: "Choose info, warning, or success." }],
});
export const cycleTone = defineCommand<{ block: string }>({ id: "nooq.callout.cycle-tone", label: "Cycle callout tone",
  validateArgs: (a): a is { block: string } => !!a && typeof a === "object" && "block" in a && typeof a.block === "string",
  prepare(ctx, args) {
    const block = ctx.snapshot.blocks[args.block];
    if (!ctx.isAlive(args.block) || block?.type !== callout.type) return { status: "not-applicable" };
    const index = tones.findIndex(tone => tone === block.fields.tone);
    if (index < 0) return { status: "not-applicable" };
    return { status: "ready", intent: "cycle-callout-tone", ops: [{ op: "setField", block: args.block, key: "tone", value: tones[(index + 1) % tones.length]! }] };
  },
});
export const insertCallout = defineCommand<{ parent: string | null; index?: number; clearBlock?: string }>({ id: "nooq.callout.insert", label: "Insert callout",
  validateArgs: (a): a is { parent: string | null; index?: number; clearBlock?: string } => !!a && typeof a === "object" && "parent" in a && (a.parent === null || typeof a.parent === "string") && (!("index" in a) || a.index === undefined || Number.isInteger(a.index)) && (!("clearBlock" in a) || a.clearBlock === undefined || typeof a.clearBlock === "string"),
  prepare(ctx, args) {
    if (args.parent !== null && !ctx.isAlive(args.parent)) return { status: "not-applicable" };
    const block = ctx.createBlock(callout.type), ops: Op[] = [];
    if (args.clearBlock) {
      if (!ctx.isAlive(args.clearBlock) || ctx.snapshot.blocks[args.clearBlock]!.text?.s !== "/") return { status: "not-applicable" };
      ops.push({ op: "textEdit", block: args.clearBlock, changes: [{ delete: 1 }] });
    }
    ops.push({ op: "insert", block, parent: args.parent, ...(args.index !== undefined ? { index: args.index } : {}) });
    return { status: "ready", intent: "insert-callout", ops, selection: { block: block.id, anchor: 0, head: 0 } };
  },
});
export const callouts = definePlugin({ id: "nooq.callouts", version: "1.0.0", apiVersion: 1, contributes: { blocks: [callout], commands: [insertCallout, cycleTone] } });
