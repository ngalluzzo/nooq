import { canonicalJson, type Op, type TextChange } from "@nooq/core";
import { defineCommand, type BlockDefinition, type Immutable } from "./definitions.ts";
import { resolveTextRange, type DocumentTextSelection } from "./selection.ts";

export interface MergeTextArgs { range: DocumentTextSelection; text: string }

/** Recomputed from the current snapshot: no inferred compatibility or subtree deletion. */
export function planTextMerge(snapshot: Immutable<import("@nooq/core").DocState>, range: DocumentTextSelection, text: string,
  definition: (type: string) => Readonly<BlockDefinition> | undefined) {
  const parts = resolveTextRange(snapshot, range);
  if (!parts || parts.length < 2 || typeof text !== "string") return;
  const first = parts[0]!, last = parts.at(-1)!, target = snapshot.blocks[first.block]!;
  if (definition(target.type)?.textMerge !== "same-type") return;
  if (parts.some(p => {
    const block = snapshot.blocks[p.block]!;
    return block.type !== target.type || block.children.length > 0 || canonicalJson(block.fields) !== canonicalJson(target.fields);
  })) return;
  // Check actual siblings, including non-text nodes that text traversal omits.
  const pending: (readonly string[])[] = [snapshot.roots];
  let siblings: readonly string[] | undefined;
  while (pending.length) {
    const ids = pending.pop()!;
    if (ids.includes(first.block)) { siblings = ids; break; }
    for (const id of ids) pending.push(snapshot.blocks[id]!.children);
  }
  const index = siblings?.indexOf(first.block) ?? -1;
  if (!siblings || parts.some((p, i) => siblings[index + i] !== p.block)) return;
  const tail = snapshot.blocks[last.block]!.text!;
  const changes: TextChange[] = [{ retain: first.from }, { delete: target.text!.s.length - first.from }];
  if (text) changes.push({ insert: text, marks: [] });
  // Copy runs, including marks unfamiliar to the current renderer, using UTF-16 positions.
  for (let from = last.to; from < tail.s.length;) {
    let to = from + 1;
    while (to < tail.s.length && canonicalJson(tail.marks[from]) === canonicalJson(tail.marks[to])) to++;
    changes.push({ insert: tail.s.slice(from, to), marks: [...tail.marks[from]!] }); from = to;
  }
  return { block: first.block, changes, removed: parts.slice(1).map(p => p.block), offset: first.from + text.length };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const point = (value: unknown) => object(value) && typeof value.block === "string" && Number.isInteger(value.offset);
export const mergeText = defineCommand<MergeTextArgs>({
  id: "nooq.text.merge", label: "Merge text blocks",
  validateArgs: (value): value is MergeTextArgs => object(value) && typeof value.text === "string" && object(value.range) && point(value.range.anchor) && point(value.range.head),
  prepare(ctx, { range, text }) {
    const plan = planTextMerge(ctx.snapshot, range, text, ctx.blockDefinition);
    if (!plan) return { status: "not-applicable" };
    const ops: Op[] = [];
    // Each selected provider may refuse. Never fall back to direct core operations.
    // Transforming overrides must supply their own merge command: this recipe only
    // admits the exact lossless plan, so a source cannot be removed after a partial edit.
    const edited = ctx.prepare("nooq.text.edit", { block: plan.block, changes: plan.changes });
    const edit: Op = { op: "textEdit", block: plan.block, changes: plan.changes };
    if (edited.status !== "ready" || canonicalJson(edited.ops) !== canonicalJson([edit])) return { status: "not-applicable" };
    ops.push(...edited.ops);
    for (const block of plan.removed) {
      const deleted = ctx.prepare("nooq.block.delete", { block });
      if (deleted.status !== "ready" || canonicalJson(deleted.ops) !== canonicalJson([{ op: "delete", block }])) return { status: "not-applicable" };
      ops.push(...deleted.ops);
    }
    return { status: "ready", intent: "merge-text", ops, selection: { block: plan.block, anchor: plan.offset, head: plan.offset } };
  },
});
