import { defineBlock, defineCommand, definePlugin } from "@nooq/plugins";
import type { CommandContext } from "@nooq/plugins";
import type { Block, Op } from "@nooq/core";

const TONES = ["info", "warning", "success"] as const;
type Tone = (typeof TONES)[number];

function isTone(value: unknown): value is Tone {
  return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

export const block = defineBlock({
  type: "seed.callout/v1",
  label: "Callout",
  text: "inline",
  create: () => ({
    fields: { tone: "info" },
    text: { s: "", marks: Array.from({ length: 0 }, () => []) },
  }),
  diagnose(block) {
    if (!("tone" in block.fields)) {
      return [{ field: "tone", message: "Missing tone" }];
    }
    const tone = block.fields.tone;
    if (typeof tone !== "string") {
      return [{ field: "tone", message: "Tone must be a string" }];
    }
    if (!(TONES as readonly string[]).includes(tone)) {
      return [{ field: "tone", message: `Tone must be one of: ${TONES.join(", ")}` }];
    }
    return [];
  },
});

const cycleToneCommand = defineCommand<{ block: string }>({
  id: "seed.callout.cycle-tone",
  label: "Cycle callout tone",
  validateArgs: (input): input is { block: string } =>
    typeof input === "object" &&
    input !== null &&
    "block" in input &&
    typeof (input as { block: unknown }).block === "string",
  prepare: (ctx: CommandContext, args) => {
    const id = args.block;
    if (!ctx.isAlive(id)) return { status: "not-applicable" };
    const stored = ctx.snapshot.blocks[id];
    if (!stored || stored.type !== "seed.callout/v1") return { status: "not-applicable" };
    const current = stored.fields.tone;
    if (!isTone(current)) return { status: "not-applicable" };
    const next = TONES[(TONES.indexOf(current) + 1) % TONES.length];
    return {
      status: "ready",
      intent: `cycle callout tone from ${current} to ${next}`,
      ops: [{ op: "setField", block: id, key: "tone", value: next }],
    };
  },
});

interface InsertArgs { parent: string | null; index?: number; clearBlock?: string }

const insertCommand = defineCommand<InsertArgs>({
  id: "seed.callout.insert",
  label: "Insert callout",
  validateArgs: (input): input is InsertArgs =>
    typeof input === "object" &&
    input !== null &&
    "parent" in input &&
    ((input as InsertArgs).parent === null || typeof (input as InsertArgs).parent === "string"),
  prepare: (ctx: CommandContext, args) => {
    const { parent, index, clearBlock } = args;
    const blockId = ctx.createBlock("seed.callout/v1");
    const ops: Op[] = [];

    if (clearBlock) {
      if (!ctx.isAlive(clearBlock)) return { status: "not-applicable" };
      const clearData = ctx.snapshot.blocks[clearBlock];
      if (!clearData || !clearData.text || clearData.text.s !== "/") {
        return { status: "not-applicable" };
      }
      const len = clearData.text.s.length;
      ops.push({
        op: "textEdit",
        block: clearBlock,
        changes: [{ start: 0, end: len, inserted: "" }] as never,
      });
    }

    ops.push({ op: "insert", block: blockId as Block, parent, index });
    return {
      status: "ready",
      intent: "insert callout",
      ops,
      selection: { block: blockId.id, anchor: 0, head: 0 },
    };
  },
});

export default definePlugin({
  id: "seed.callouts",
  version: "0.1.0",
  apiVersion: 1,
  contributes: { blocks: [block], commands: [cycleToneCommand, insertCommand] },
});
