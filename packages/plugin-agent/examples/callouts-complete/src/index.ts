import { defineBlock, defineCommand, definePlugin } from "@nooq/plugins";
import type { Block, CommandContext, Diagnostic, Immutable, Op, PreparedCommand } from "@nooq/plugins";

const TONES = ["info", "warning", "success"] as const;
type Tone = (typeof TONES)[number];

function isTone(value: unknown): value is Tone {
  return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

export const block = defineBlock({
  type: "seed.callout/v1",
  label: "Callout",
  text: "inline",
  create: () => ({ fields: { tone: "info" }, text: { s: "", marks: [] as string[][] } }),
  diagnose(block: Immutable<Block>): readonly Diagnostic[] {
    const tone = block.fields["tone"];
    if (tone === undefined || tone === null) {
      return [{ field: "tone", message: "Callout is missing a tone" }];
    }
    if (!isTone(tone)) {
      return [{ field: "tone", message: "Callout tone must be one of info, warning, or success" }];
    }
    return [];
  },
});

const cycleCommand = defineCommand<{ block: string }>({
  id: "seed.callout.cycle-tone",
  label: "Cycle callout tone",
  validateArgs: (input): input is { block: string } =>
    typeof input === "object" &&
    input !== null &&
    "block" in input &&
    typeof (input as { block: unknown }).block === "string",
  prepare(ctx: CommandContext, args: { block: string }): PreparedCommand {
    if (!ctx.isAlive(args.block)) {
      return { status: "not-applicable" };
    }
    const snapshotBlock = ctx.snapshot.blocks[args.block] as Block | undefined;
    if (!snapshotBlock || snapshotBlock.type !== "seed.callout/v1") {
      return { status: "not-applicable" };
    }
    const current = snapshotBlock.fields["tone"];
    if (!isTone(current)) {
      return { status: "not-applicable" };
    }
    const next: Tone =
      current === "info" ? "warning" : current === "warning" ? "success" : "info";
    return {
      status: "ready",
      intent: "Cycle callout tone to " + next,
      ops: [{ op: "setField", block: args.block, key: "tone", value: next }],
    };
  },
});

interface InsertArgs {
  parent: string | null;
  index?: number;
  clearBlock?: string;
}

const insertCommand = defineCommand<InsertArgs>({
  id: "seed.callout.insert",
  label: "Insert callout",
  validateArgs: (input): input is InsertArgs => {
    if (typeof input !== "object" || input === null) return false;
    const record = input as Record<string, unknown>;
    if (!("parent" in record)) return false;
    if (record.parent !== null && typeof record.parent !== "string") return false;
    if ("index" in record && record.index !== undefined) {
      if (typeof record.index !== "number" || !Number.isInteger(record.index)) return false;
    }
    if ("clearBlock" in record && record.clearBlock !== undefined) {
      if (typeof record.clearBlock !== "string") return false;
    }
    return true;
  },
  prepare(ctx: CommandContext, args: InsertArgs): PreparedCommand {
    const ops: Op[] = [];
    if (args.parent !== null && !ctx.isAlive(args.parent)) {
      return { status: "not-applicable" };
    }
    if (args.clearBlock !== undefined) {
      if (!ctx.isAlive(args.clearBlock)) return { status: "not-applicable" };
      const target = ctx.snapshot.blocks[args.clearBlock] as Block | undefined;
      if (target?.text?.s !== "/") return { status: "not-applicable" };
      ops.push({ op: "textEdit", block: args.clearBlock, changes: [{ delete: 1 }] });
    }
    const created = ctx.createBlock("seed.callout/v1");
    const insertOp: Op = { op: "insert", block: created, parent: args.parent };
    if (args.index !== undefined) (insertOp as { index?: number }).index = args.index;
    ops.push(insertOp);
    return {
      status: "ready",
      intent: "Insert callout",
      ops,
      selection: { block: created.id, anchor: 0, head: 0 },
    };
  },
});

export default definePlugin({
  id: "seed.callouts",
  version: "0.1.0",
  apiVersion: 1,
  contributes: { blocks: [block], commands: [cycleCommand, insertCommand] },
});
