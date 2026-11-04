import { pasteBlocks } from "./paste.ts";
export { isPasteTextBlock, pasteBlocks, PASTE_INTENT, type PasteBlock } from "./paste.ts";
import { column, columns, placeBeside, resizeColumns } from "./columns.ts";
export { column, columns, collapsedLayoutBlock, columnPlacement, columnWeights, layoutColumns, placeBeside, resizeColumns, MAX_LAYOUT_COLUMNS, MIN_LAYOUT_COLUMN_WIDTH, PLACE_BESIDE_INTENT, type PlaceBesideArgs } from "./columns.ts";
import { defineBlock, defineCommand, definePlugin } from "./definitions.ts";
import { markWithPayload, type InsertBlockArgs } from "./recipes.ts";
import { mergeText } from "./merge.ts";
export { mergeText } from "./merge.ts";
import type { Op, TextChange } from "@nooq/core";

const textBlock = (type: string, label: string) => defineBlock({ type, label, text: "inline", textMerge: "same-type", create: () => ({ fields: {}, text: { s: "", marks: [] } }), diagnose: () => [] });
export const paragraph = textBlock("nooq.paragraph/v1", "Text");
/**
 * Headings carry their level as a field (DM-3.2: data, not type variants —
 * one block type, six levels). The reference renders h1-h6 by it; export
 * hashes per it; split carries it (Tier-1).
 */
export const heading = defineBlock({
  type: "nooq.heading/v1", label: "Heading",
  text: "inline", textMerge: "same-type",
  create: () => ({ fields: { level: 2 }, text: { s: "", marks: [] } }),
  diagnose: () => [],
});
/**
 * The divider (Tier-1): textless, one horizontal rule. `---` in markdown.
 */
export const divider = defineBlock({
  type: "nooq.divider/v1", label: "Divider",
  text: "none", create: () => ({ fields: {} }), diagnose: () => [],
});
export const quote = textBlock("nooq.quote/v1", "Quote");
/**
 * The document's title (foundation P2): an ordinary inline-text block — the
 * reference keeps one per document as convention, never as a rule the model
 * enforces, so hosts and plugins treat it exactly like any other block (§7).
 */
export const title = textBlock("nooq.title/v1", "Title");
/**
 * List items (DM-3.2 structure, Tier-1 surface): ONE block type, three
 * kinds by field — bullet, number, check — nesting through children like
 * every block (§7: the model adds no list-specific rules). `checked` is
 * only meaningful for kind "check"; the surface renders the box.
 */
export const listItem = defineBlock({
  type: "nooq.list/v1", label: "List item",
  text: "inline", textMerge: "same-type",
  create: () => ({ fields: { kind: "bullet" }, text: { s: "", marks: [] } }),
  diagnose: () => [],
});
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";

export const insertBlock = defineCommand<{ type: string; parent: string | null; index?: number; clearBlock?: string; fields?: Record<string, import("@nooq/core").JsonValue> }>({
  id: "nooq.block.insert", label: "Insert block",
  validateArgs: (a): a is { type: string; parent: string | null; index?: number; clearBlock?: string; fields?: Record<string, import("@nooq/core").JsonValue> } => object(a) && typeof a.type === "string" && (a.parent === null || typeof a.parent === "string") && (a.index === undefined || Number.isInteger(a.index)) && (a.clearBlock === undefined || typeof a.clearBlock === "string") && (a.fields === undefined || object(a.fields)),
  prepare(ctx, args) {
    if (args.parent !== null && !ctx.isAlive(args.parent)) return { status: "not-applicable" };
    const block = ctx.createBlock(args.type);
    if (args.fields) block.fields = { ...block.fields, ...args.fields }; // Tier-1: the slash picks the list kind
    const ops: Op[] = [];
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
    const parent = ctx.parentOf(id)!;
    const siblings = parent === null ? ctx.snapshot.roots : ctx.snapshot.blocks[parent]!.children;
    // Same-type split (Tier-1): the new block continues what was split — a
    // list item begets a list item of the same kind, a heading a heading —
    // EXCEPT an empty list item, where Enter exits the list to a paragraph.
    const isList = target.type === listItem.type;
    if (isList && text.s.length === 0 && from === 0 && to === 0) {
      const exit = ctx.createBlock(paragraph.type);
      return { status: "ready", intent: "exit-list", ops: [
        { op: "delete", block: id },
        { op: "insert", block: exit, parent, index: siblings.indexOf(id) },
      ], selection: { block: exit.id, anchor: 0, head: 0 } };
    }
    const block = ctx.createBlock(isList ? listItem.type : target.type);
    if (isList) block.fields = { ...target.fields } as Record<string, import("@nooq/core").JsonValue>;
    else if (target.type !== paragraph.type) {
      // Non-list built-ins (heading, quote) keep their fields — the model
      // carries them; the reference renders what fields say.
      block.fields = { ...target.fields } as Record<string, import("@nooq/core").JsonValue>;
    }
    block.text = { s: text.s.slice(to), marks: text.marks.slice(to).map(m => [...m]) };
    return { status: "ready", intent: "split-block", ops: [
      { op: "textEdit", block: id, changes: [{ retain: from }, { delete: text.s.length - from }] },
      { op: "insert", block, parent, index: siblings.indexOf(id) + 1 },
    ], selection: { block: block.id, anchor: 0, head: 0 } };
  },
});
/** Paste's command (Tier-2, gap audit #5): a whole imported tree in ONE
 *  transaction — the same single-tx discipline as insertColumns. The tree
 *  walks depth-first; each child's op cites its parent's already-inserted id.
 */
export const importBlocks = defineCommand<{ blocks: readonly import("./import.ts").ImportedBlock[]; after: string }>({
  id: "nooq.doc.import", label: "Import blocks",
  validateArgs: (a): a is { blocks: readonly import("./import.ts").ImportedBlock[]; after: string } => object(a) && Array.isArray(a.blocks) && typeof a.after === "string",
  prepare(ctx, { blocks, after }) {
    if (!ctx.isAlive(after)) return { status: "not-applicable" };
    const parentFound = ctx.parentOf(after);
    if (parentFound === undefined) return { status: "not-applicable" };
    const parent = parentFound;
    if (parent !== null && !ctx.isAlive(parent)) return { status: "not-applicable" };
    const siblings = parent === null ? ctx.snapshot.roots : (ctx.snapshot.blocks[parent]!.children as readonly string[]);
    const index = siblings.indexOf(after) + 1;
    const ops: Op[] = [];
    let selection: { block: string; anchor: number; head: number } | undefined;
    const walk = (nodes: readonly import("./import.ts").ImportedBlock[], at: { parent: string | null; index: number }): void => {
      for (let i = 0; i < nodes.length; i++) {
        const { data, children } = nodes[i]!;
        // createBlock stamps the attribution the engine demands (the active
        // actor, no fields); the import's CONTENT — fields and text — carries
        // over. The ids stay the import's so children resolve.
        const block = ctx.createBlock(data.type);
        block.id = data.id;
        block.fields = { ...data.fields };
        if (data.text) block.text = data.text;
        ops.push({ op: "insert", block, parent: at.parent, index: at.index + i });
        if (selection === undefined && data.text) selection = { block: data.id, anchor: data.text.s.length, head: data.text.s.length };
        walk(children, { parent: data.id, index: 0 });
      }
    };
    walk(blocks, { parent, index });
    if (ops.length === 0) return { status: "not-applicable" };
    return { status: "ready", intent: "import-blocks", ops, ...(selection ? { selection } : {}) };
  },
});

/** One field write as a command (DM-3.2): the generic primitive behind
 *  every picker — the language select, heading levels, list kinds. */
export const setField = defineCommand<{ block: string; key: string; value: import("@nooq/core").JsonValue }>({
  id: "nooq.field.set", label: "Set field",
  validateArgs: (a): a is { block: string; key: string; value: import("@nooq/core").JsonValue } => object(a) && typeof a.block === "string" && typeof a.key === "string" && a.key !== "" && "value" in a,
  prepare(ctx, { block: id, key, value }) {
    if (!ctx.isAlive(id)) return { status: "not-applicable" };
    const current = ctx.snapshot.blocks[id]!.fields[key];
    const same = JSON.stringify(current ?? null) === JSON.stringify(value ?? null);
    if (same) return { status: "not-applicable" }; // a no-op write is not a transaction
    return { status: "ready", intent: "set-field", ops: [
      { op: "setField", block: id, key, value },
    ] };
  },
});

/** The drag handle's command (Tier-1, DM-4): one move op — a branch moves
 *  as a branch, one transaction, supersession resolution DM-4.7/4.9. */
export const moveBlock = defineCommand<{ block: string; parent: string | null; index: number }>({
  id: "nooq.block.move", label: "Move block",
  validateArgs: (a): a is { block: string; parent: string | null; index: number } => object(a) && typeof a.block === "string" && (a.parent === null || typeof a.parent === "string") && Number.isInteger(a.index as number) && (a.index as number) >= 0,
  prepare(ctx, { block: id, parent, index }) {
    if (!ctx.isAlive(id)) return { status: "not-applicable" };
    if (parent !== null && !ctx.isAlive(parent)) return { status: "not-applicable" };
    if (parent === id) return { status: "not-applicable" }; // DM-3.1: never under itself
    if (parent !== null) {
      // DM-3.1: never under its own subtree either — the UI must not offer
      // what applyMove would reject; compute, don't throw.
      const subtree = new Set<string>([id]);
      const grow = (bid: string): void => { for (const child of (ctx.snapshot.blocks[bid]?.children ?? []) as readonly string[]) if (!subtree.has(child)) { subtree.add(child); grow(child); } };
      grow(id);
      if (subtree.has(parent)) return { status: "not-applicable" };
    }
    // The index is where the LINE said — computed against the destination
    // BEFORE the move; applyMove enforces the subtree rule.
    const view = ctx.snapshot;
    const tree = (view as { roots: readonly string[]; blocks: Record<string, { children: readonly string[] }> });
    const dest = parent === null ? tree.roots : tree.blocks[parent]?.children ?? [];
    const at = Math.min(index, dest.length);
    // Moving to the same place is a no-op, not a transaction.
    const currentParent = Object.entries(tree.blocks).find(([, b]) => b.children.includes(id))?.[0] ?? null;
    if (currentParent === parent && dest.indexOf(id) === at) return { status: "not-applicable" };
    return { status: "ready", intent: "move-block", ops: [
      { op: "move", block: id, newParent: parent, index: at },
    ] };
  },
});

/** The checkbox IS the field (Tier-1): one op, one transaction, undoable. */
export const toggleCheck = defineCommand<{ block: string }>({
  id: "nooq.list.check", label: "Toggle to-do",
  validateArgs: (a): a is { block: string } => object(a) && typeof a.block === "string",
  prepare(ctx, { block: id }) {
    if (!ctx.isAlive(id)) return { status: "not-applicable" };
    const target = ctx.snapshot.blocks[id]!;
    if (target.type !== listItem.type || target.fields.kind !== "check") return { status: "not-applicable" };
    // setField always carries a value (DM-4): unchecked is false, not absent.
    const next = target.fields.checked === true ? false : true;
    return { status: "ready", intent: "toggle-check", ops: [
      { op: "setField", block: id, key: "checked", value: next },
    ] };
  },
});
/**
 * Multi-column layout in ONE authorized transaction ("insert-columns"): the
 * columns block at the slash position (the "/" consumed exactly as
 * insertAfterSelection-based flows do), two column children each seeded with
 * an empty paragraph, and the prepared selection landing in column 1's
 * paragraph. Declines like every insert: a dead parent, an index past the
 * end, or a slash that is no longer exactly "/" (a menu may stay open while
 * remote text arrives).
 */
export const insertColumns = defineCommand<InsertBlockArgs>({
  id: "nooq.columns.insert", label: "Insert columns",
  validateArgs: (a): a is InsertBlockArgs => object(a) && (a.parent === null || typeof a.parent === "string")
    && (a.index === undefined || (Number.isSafeInteger(a.index) && (a.index as number) >= 0))
    && (a.clearBlock === undefined || typeof a.clearBlock === "string"),
  prepare(ctx, args) {
    if (args.parent !== null && !ctx.isAlive(args.parent)) return { status: "not-applicable" };
    const siblings = args.parent === null ? ctx.snapshot.roots : ctx.snapshot.blocks[args.parent]!.children;
    if (args.index !== undefined && args.index > siblings.length) return { status: "not-applicable" };
    const ops: Op[] = [];
    if (args.clearBlock !== undefined) {
      if (!ctx.isAlive(args.clearBlock) || ctx.snapshot.blocks[args.clearBlock]?.text?.s !== "/") return { status: "not-applicable" };
      ops.push({ op: "textEdit", block: args.clearBlock, changes: [{ delete: 1 }] });
    }
    const columnsBlock = ctx.createBlock(columns.type);
    ops.push({ op: "insert", block: columnsBlock, parent: args.parent, ...(args.index !== undefined ? { index: args.index } : {}) });
    const left = ctx.createBlock(column.type), leftText = ctx.createBlock(paragraph.type);
    ops.push({ op: "insert", block: left, parent: columnsBlock.id, index: 0 }, { op: "insert", block: leftText, parent: left.id, index: 0 });
    const right = ctx.createBlock(column.type), rightText = ctx.createBlock(paragraph.type);
    ops.push({ op: "insert", block: right, parent: columnsBlock.id, index: 1 }, { op: "insert", block: rightText, parent: right.id, index: 0 });
    return { status: "ready", intent: "insert-columns", ops, selection: { block: leftText.id, anchor: 0, head: 0 } };
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
  contributes: { blocks: [paragraph, heading, divider, quote, title, listItem, columns, column], commands: [insertBlock, editText, deleteBlock, splitBlock, mergeText, link, importBlocks, pasteBlocks, insertColumns, placeBeside, resizeColumns, setField, toggleCheck, moveBlock] },
});
