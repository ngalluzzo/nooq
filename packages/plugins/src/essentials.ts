import { defineBlock, defineCommand, definePlugin } from "./definitions.ts";
import { markWithPayload } from "./recipes.ts";
import { mergeText } from "./merge.ts";
export { mergeText } from "./merge.ts";
import type { Op, TextChange } from "@nooq/core";

const textBlock = (type: string, label: string) => defineBlock({ type, label, text: "inline", textMerge: "same-type", create: () => ({ fields: {}, text: { s: "", marks: [] } }), diagnose: () => [] });
export const paragraph = textBlock("nooq.paragraph/v1", "Text");
export const heading = textBlock("nooq.heading/v1", "Heading");
export const quote = textBlock("nooq.quote/v1", "Quote");
/**
 * The document's title (foundation P2): an ordinary inline-text block — the
 * reference keeps one per document as convention, never as a rule the model
 * enforces, so hosts and plugins treat it exactly like any other block (§7).
 */
export const title = textBlock("nooq.title/v1", "Title");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";

export const insertBlock = defineCommand<{ type: string; parent: string | null; index?: number; clearBlock?: string }>({
  id: "nooq.block.insert", label: "Insert block",
  validateArgs: (a): a is { type: string; parent: string | null; index?: number; clearBlock?: string } => object(a) && typeof a.type === "string" && (a.parent === null || typeof a.parent === "string") && (a.index === undefined || Number.isInteger(a.index)) && (a.clearBlock === undefined || typeof a.clearBlock === "string"),
  prepare(ctx, args) {
    if (args.parent !== null && !ctx.isAlive(args.parent)) return { status: "not-applicable" };
    const block = ctx.createBlock(args.type), ops: Op[] = [];
    if (args.clearBlock) {
      // A menu may stay open while remote text arrives. Only consume its slash.
      if (!ctx.isAlive(args.clearBlock) || ctx.snapshot.blocks[args.clearBlock]!.text?.s !== "/") return { status: "not-applicable" };
      ops.push({ op: "textEdit", block: args.clearBlock, changes: [{ delete: 1 }] });
    }
    ops.push({ op: "insert", block, parent: args.parent, ...(args.index !== undefined ? { index: args.index } : {}) });
    return { status: "ready", intent: `insert:${args.type}`, ops, selection: { block: block.id, anchor: 0, head: 0 } };
  },
});
export const editText = defineCommand<{ block: string; changes: TextChange[] }>({
  id: "nooq.text.edit", label: "Edit text",
  validateArgs: (a): a is { block: string; changes: TextChange[] } => object(a) && typeof a.block === "string" && Array.isArray(a.changes),
  prepare: (ctx, args) => ctx.isAlive(args.block) ? { status: "ready", intent: "type", ops: [{ op: "textEdit", block: args.block, changes: args.changes }] } : { status: "not-applicable" },
});
export const deleteBlock = defineCommand<{ block: string }>({
  id: "nooq.block.delete", label: "Delete block",
  validateArgs: (a): a is { block: string } => object(a) && typeof a.block === "string",
  prepare(ctx, args) {
    if (!ctx.isAlive(args.block)) return { status: "not-applicable" };
    const order: string[] = [];
    const walk = (ids: readonly string[]) => { for (const id of ids) { order.push(id); walk(ctx.snapshot.blocks[id]!.children); } };
    walk(ctx.snapshot.roots);
    const previous = order[order.indexOf(args.block) - 1], offset = previous ? ctx.snapshot.blocks[previous]!.text?.s.length ?? 0 : 0;
    return { status: "ready", intent: "delete", ops: [{ op: "delete", block: args.block }],
      ...(previous ? { selection: { block: previous, anchor: offset, head: offset } } : {}),
    };
  },
});
export const splitBlock = defineCommand<{ block: string; anchor: number; head: number }>({
  id: "nooq.text.split", label: "Split paragraph",
  validateArgs: (a): a is { block: string; anchor: number; head: number } => object(a) && typeof a.block === "string" && Number.isInteger(a.anchor) && Number.isInteger(a.head),
  prepare(ctx, { block: id, anchor, head }) {
    if (!ctx.isAlive(id)) return { status: "not-applicable" };
    const target = ctx.snapshot.blocks[id]!, text = target.text ?? { s: "", marks: [] };
    const from = Math.min(anchor, head), to = Math.max(anchor, head);
    if (from < 0 || to > text.s.length) throw new Error("Selection out of range");
    const block = ctx.createBlock(paragraph.type);
    block.text = { s: text.s.slice(to), marks: text.marks.slice(to).map(m => [...m]) };
    const parent = ctx.parentOf(id)!;
    const siblings = parent === null ? ctx.snapshot.roots : ctx.snapshot.blocks[parent]!.children;
    return { status: "ready", intent: "split-block", ops: [
      { op: "textEdit", block: id, changes: [{ retain: from }, { delete: text.s.length - from }] },
      { op: "insert", block, parent, index: siblings.indexOf(id) + 1 },
    ], selection: { block: block.id, anchor: 0, head: 0 } };
  },
});
/**
 * The payload recipe behind nooq's own link mark (0009 §5): the reserved
 * bare base `link` with the href as its payload, dogfooded through the same
 * path a plugin author would use.
 */
const linkRecipe = markWithPayload("link", { id: "nooq.text.link", label: "Link",
  intents: { apply: "add-link", remove: "remove-link" },
  validatePayload: (value): value is string => typeof value === "string" && value.length > 0,
});
export interface LinkArgs { block: string; from: number; to: number; href?: string }
/** A nonempty href links the range; omitting it removes the link (the field stays, DM-3.4). */
export const link = defineCommand<LinkArgs>({
  id: "nooq.text.link", label: "Link",
  validateArgs: (a): a is LinkArgs => object(a) && typeof a.block === "string" && Number.isSafeInteger(a.from) && Number.isSafeInteger(a.to)
    && (a.href === undefined || (typeof a.href === "string" && a.href.length > 0)),
  prepare: (ctx, args) => linkRecipe.prepare(ctx, { block: args.block, from: args.from, to: args.to, ...(args.href !== undefined ? { payload: args.href } : {}) }),
});
export const essentials = definePlugin({ id: "nooq.essentials", version: "1.0.0", apiVersion: 1,
  contributes: { blocks: [paragraph, heading, quote, title], commands: [insertBlock, editText, deleteBlock, splitBlock, mergeText, link] },
});
