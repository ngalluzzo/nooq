import { canonicalJson, markedInserts, type Block, type JsonValue, type Op, type RenderedText, type TextChange } from "@nooq/core";
import { defineCommand, type CommandContext, type Immutable, type SelectionRequest } from "./definitions.ts";
import { resolveTextRange, type DocumentTextSelection } from "./selection.ts";
import { baseOf } from "./text-policy.ts";

export const PASTE_INTENT = "paste";
export interface PasteBlock {
  type: string;
  text?: RenderedText;
  fields?: Record<string, JsonValue>;
  children: PasteBlock[];
}

const paragraph = "nooq.paragraph/v1";
const prose = new Set([paragraph, "nooq.heading/v1", "nooq.quote/v1", "nooq.list/v1", "nooq.title/v1"]);
export const isPasteTextBlock = (type: string | undefined): boolean => type !== undefined && prose.has(type);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const point = (value: unknown) => object(value) && typeof value.block === "string" && Number.isSafeInteger(value.offset);

function slice(text: Immutable<RenderedText>, from: number): RenderedText {
  return { s: text.s.slice(from), marks: text.marks.slice(from).map(marks => [...marks]) };
}

/** Copy payloads with the text that refers to them, remapping collisions between blocks. */
function carry(text: RenderedText, source: Immutable<Block["fields"]>, destination: Block["fields"], allowed?: readonly string[]): RenderedText {
  const remapped = new Map<string, string>();
  const marks = text.marks.map(names => (allowed ? names.filter(name => allowed.includes(baseOf(name))) : names).map(name => {
    const base = baseOf(name);
    if (base === name || !Object.hasOwn(source, name)) return name;
    const known = remapped.get(name);
    if (known) return known;
    const value = source[name];
    if (value === undefined) return name;
    const token = Object.hasOwn(destination, name) && canonicalJson(destination[name]) !== canonicalJson(value)
      ? `${base}:${crypto.randomUUID()}` : name;
    destination[token] = structuredClone(value) as JsonValue;
    remapped.set(name, token);
    return token;
  }).sort());
  return { s: text.s, marks };
}

function prepareEdit(ctx: CommandContext, block: Immutable<Block>, from: number, to: number, insert: RenderedText, fields: Block["fields"]): Op[] | undefined {
  const changes: TextChange[] = [{ retain: from }, { delete: to - from }, ...markedInserts(insert)];
  if (from === to && !insert.s) return [];
  const edit = ctx.prepare("nooq.text.edit", { block: block.id, changes });
  if (edit.status !== "ready" || canonicalJson(edit.ops) !== canonicalJson([{ op: "textEdit", block: block.id, changes }])) return;
  const ops: Op[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(block.fields, key)) ops.push({ op: "setField", block: block.id, key, value });
  }
  return [...ops, ...edit.ops];
}

interface PasteArgs { range: DocumentTextSelection; blocks: PasteBlock[]; marks?: readonly string[] }

export const pasteBlocks = defineCommand<PasteArgs>({
  id: "nooq.doc.paste", label: "Paste blocks",
  validateArgs: (args): args is PasteArgs => object(args) && Array.isArray(args.blocks)
    && object(args.range) && point(args.range.anchor) && point(args.range.head)
    && (args.marks === undefined || (Array.isArray(args.marks) && args.marks.every(mark => typeof mark === "string"))),
  prepare(ctx, { range, blocks, marks }) {
    const { anchor, head } = range, state = ctx.snapshot;
    if (!blocks.length) return { status: "not-applicable" };
    const parts = anchor.block === head.block
      ? [{ block: anchor.block, from: Math.min(anchor.offset, head.offset), to: Math.max(anchor.offset, head.offset) }]
      : resolveTextRange(state, range);
    if (!parts?.length || parts.some(part => {
      const block = state.blocks[part.block];
      return !ctx.isAlive(part.block) || !block?.text || !isPasteTextBlock(block.type) || part.from < 0 || part.to > block.text.s.length;
    })) return { status: "not-applicable" };
    const first = parts[0]!, last = parts.at(-1)!;
    const start = state.blocks[first.block]!, end = state.blocks[last.block]!;
    const leading = blocks[0]!;
    const inline = blocks.length === 1 && leading.type === paragraph && !!leading.text && !leading.children.length;
    const destination = structuredClone(start.fields) as Block["fields"];
    if (inline && start === end) {
      const text = carry(leading.text!, leading.fields ?? {}, destination, marks);
      const ops = prepareEdit(ctx, start, first.from, first.to, text, destination);
      if (!ops?.length) return { status: "not-applicable" };
      const offset = first.from + text.s.length;
      return { status: "ready", intent: PASTE_INTENT, ops, selection: { block: start.id, anchor: offset, head: offset } };
    }

    const parent = ctx.parentOf(start.id);
    if (parent === undefined) return { status: "not-applicable" };
    const siblings = parent === null ? state.roots : state.blocks[parent]!.children;
    const at = siblings.indexOf(start.id);
    // A structural paste may replace adjacent prose leaves. Leave structural
    // boundaries and plugin-owned content to their existing plain-text path.
    if (at < 0 || parts.some((part, i) => siblings[at + i] !== part.block || state.blocks[part.block]!.children.length)) return { status: "not-applicable" };

    const imported = structuredClone(blocks);
    const tail = slice(end.text!, last.to);
    let selection: SelectionRequest | undefined;
    const joinHead = leading.type === paragraph && start.type === paragraph && !!leading.text?.s;
    const before = joinHead ? carry(imported.shift()!.text!, leading.fields ?? {}, destination, marks) : { s: "", marks: [] };
    let trailingCaret: number | undefined;
    if (!imported.length && tail.s && start.type === paragraph && end.type === paragraph) {
      trailingCaret = before.s.length;
      const suffix = carry(tail, end.fields, destination);
      before.s += suffix.s;
      before.marks.push(...suffix.marks);
    }
    const dropStart = first.from === 0 && !before.s && imported.length > 0;
    const ops: Op[] = [];
    if (!dropStart) {
      const edit = prepareEdit(ctx, start, first.from, start.text!.s.length, before, destination);
      if (!edit) return { status: "not-applicable" };
      ops.push(...edit);
      const offset = first.from + (trailingCaret ?? before.s.length);
      selection = { block: start.id, anchor: offset, head: offset };
    }
    for (const part of parts.filter((_, i) => i > 0 || dropStart)) {
      const deleted = ctx.prepare("nooq.block.delete", { block: part.block });
      if (deleted.status !== "ready" || canonicalJson(deleted.ops) !== canonicalJson([{ op: "delete", block: part.block }])) return { status: "not-applicable" };
      ops.push(...deleted.ops);
    }

    let suffixBlock: PasteBlock | undefined;
    const final = imported.at(-1);
    let finalCaret: number | undefined;
    if (tail.s && trailingCaret === undefined) {
      if (final?.type === paragraph && end.type === paragraph && final.text) {
        finalCaret = final.text.s.length;
        const suffix = carry(tail, end.fields, final.fields ??= {});
        final.text.s += suffix.s;
        final.text.marks.push(...suffix.marks);
      } else {
        suffixBlock = { type: end.type, text: tail, fields: structuredClone(end.fields) as Block["fields"], children: [] };
      }
    }
    const insert = (node: PasteBlock, parent: string | null, index: number, caret?: number) => {
      const block = ctx.createBlock(node.type);
      block.fields = { ...block.fields, ...node.fields };
      if (node.text) block.text = node.text;
      ops.push({ op: "insert", block, parent, index });
      if (block.text) selection = { block: block.id, anchor: caret ?? block.text.s.length, head: caret ?? block.text.s.length };
      node.children.forEach((child, i) => insert(child, block.id, i));
    };
    const offset = at + Number(!dropStart);
    imported.forEach((node, i) => insert(node, parent, offset + i, node === final ? finalCaret : undefined));
    if (suffixBlock) {
      const afterPaste = selection;
      insert(suffixBlock, parent, offset + imported.length, 0);
      if (afterPaste) selection = afterPaste;
    }
    return ops.length ? { status: "ready", intent: PASTE_INTENT, ops, ...(selection ? { selection } : {}) } : { status: "not-applicable" };
  },
});
