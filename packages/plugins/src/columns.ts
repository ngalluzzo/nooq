import type { DocState, Op } from "@nooq/core";
import { defineBlock, defineCommand, type Immutable } from "./definitions.ts";

export const columns = defineBlock({
  type: "nooq.columns/v1", label: "Columns", text: "none",
  create: () => ({ fields: { widths: {} } }), diagnose: () => [],
});
export const column = defineBlock({
  type: "nooq.column/v1", label: "Column", text: "none",
  create: () => ({ fields: {} }), diagnose: () => [],
});

export const MAX_LAYOUT_COLUMNS = 3;
export const MIN_LAYOUT_COLUMN_WIDTH = 144;
export const PLACE_BESIDE_INTENT = "place-beside";

type LayoutBlock = Immutable<DocState["blocks"][string]>;

/** An empty lane retired by undo can become visible again when a peer fills it. */
export function collapsedLayoutBlock(state: Immutable<DocState>, block: LayoutBlock): boolean {
  if (block.fields.collapseWhenEmpty !== true) return false;
  if (block.type === column.type) return block.children.length === 0;
  return block.type === columns.type && layoutColumns(state, block).length === 0;
}

export function layoutColumns(state: Immutable<DocState>, group: LayoutBlock): readonly string[] {
  return group.children.filter(id => {
    const child = state.blocks[id];
    return child?.type !== column.type || !collapsedLayoutBlock(state, child);
  });
}

export function columnWeights(block: LayoutBlock): Record<string, number> {
  const widths = block.fields.widths;
  return Object.fromEntries(block.children.map(id => {
    const value = widths && typeof widths === "object" && !Array.isArray(widths) && Object.hasOwn(widths, id)
      ? (widths as Readonly<Record<string, unknown>>)[id] : undefined;
    return [id, typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_LAYOUT_COLUMNS ? value : 1];
  }));
}

function writeWidths(block: Immutable<DocState["blocks"][string]>, value: Record<string, number>): Op[] {
  const ops: Op[] = [];
  // Old layouts have no field to invert. Record their equal-width default
  // inside the same transaction so the first resize can still be undone.
  if (!Object.hasOwn(block.fields, "widths")) ops.push({ op: "setField", block: block.id, key: "widths", value: {} });
  ops.push({ op: "setField", block: block.id, key: "widths", value });
  return ops;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";

interface ResizeColumnsArgs { group: string; left: string; right: string; share: number }
export const resizeColumns = defineCommand<ResizeColumnsArgs>({
  id: "nooq.columns.resize", label: "Resize columns",
  validateArgs: (a): a is ResizeColumnsArgs => object(a) && typeof a.group === "string"
    && typeof a.left === "string" && typeof a.right === "string"
    && typeof a.share === "number" && a.share > 0 && a.share < 1,
  prepare(ctx, { group, left, right, share }) {
    const block = ctx.snapshot.blocks[group];
    if (block?.type !== columns.type || !ctx.isAlive(group)) return { status: "not-applicable" };
    const lanes = layoutColumns(ctx.snapshot, block);
    const at = lanes.indexOf(left);
    if (at < 0 || lanes[at + 1] !== right || lanes.length > MAX_LAYOUT_COLUMNS ||
      ctx.snapshot.blocks[left]?.type !== column.type || ctx.snapshot.blocks[right]?.type !== column.type) return { status: "not-applicable" };
    const weights = columnWeights(block);
    const total = weights[left]! + weights[right]!;
    const next = total * share;
    if (Math.abs(weights[left]! - next) < 1e-6) return { status: "not-applicable" };
    weights[left] = next;
    weights[right] = total - next;
    // Keep the scale bounded as neighbors are repeatedly resized.
    const mean = lanes.reduce((sum, id) => sum + weights[id]!, 0) / lanes.length;
    for (const id of lanes) weights[id] /= mean;
    return { status: "ready", intent: "resize-columns", ops: writeWidths(block, weights) };
  },
});

export interface PlaceBesideArgs { block: string; target: string; side: "left" | "right" }

type Placement =
  | { kind: "wrap"; target: string; parent: string | null; index: number }
  | { kind: "add"; target: string; group: string; index: number }
  | { kind: "reorder"; target: string; group: string; index: number; moving: string };

const tableParts = new Set(["nooq.table-row/v1", "nooq.table-cell/v1"]);

export function columnPlacement(
  state: Immutable<DocState>, parentOf: (id: string) => string | null | undefined,
  { block, target, side }: PlaceBesideArgs,
): Placement | undefined {
  const sourceType = state.blocks[block]?.type, targetType = state.blocks[target]?.type;
  if (!sourceType || !targetType || block === target || sourceType === column.type || sourceType === columns.type
    || targetType === columns.type || tableParts.has(sourceType) || tableParts.has(targetType)) return;
  const sourceParent = parentOf(block), targetParent = parentOf(target);
  if (sourceParent === undefined || targetParent === undefined) return;

  let lane = targetType === column.type ? target : undefined;
  for (let id: string | null | undefined = targetParent; id != null; id = parentOf(id)) {
    if (id === block || tableParts.has(state.blocks[id]!.type)) return;
    if (!lane && state.blocks[id]!.type === column.type) lane = id;
  }
  // The target could be the source's ancestor. Wrapping it would hide the
  // source inside one of the branches being moved.
  for (let id = sourceParent; id != null; id = parentOf(id) ?? null) if (id === target) return;

  if (!lane) {
    const siblings = targetParent === null ? state.roots : state.blocks[targetParent]!.children;
    return { kind: "wrap", target, parent: targetParent, index: siblings.indexOf(target) };
  }
  const group = parentOf(lane);
  const layout = group ? state.blocks[group] : undefined;
  if (!group || layout?.type !== columns.type || layout.children.some(id => state.blocks[id]?.type !== column.type)) return;
  const lanes = layoutColumns(state, layout);
  if (!lanes.includes(lane)) return;
  const index = layout.children.indexOf(lane) + (side === "right" ? 1 : 0);
  if (sourceParent && lanes.includes(sourceParent) && state.blocks[sourceParent]!.children.length === 1) {
    const oldSlot = lanes.indexOf(sourceParent);
    const newSlot = lanes.indexOf(lane) + Number(side === "right");
    if (newSlot - Number(oldSlot < newSlot) === oldSlot) return;
    const from = layout.children.indexOf(sourceParent);
    const to = index - Number(from < index);
    return { kind: "reorder", group, target: lane, index: to, moving: sourceParent };
  }
  if (lanes.length >= MAX_LAYOUT_COLUMNS) return;
  return { kind: "add", group, target: lane, index };
}

export const placeBeside = defineCommand<PlaceBesideArgs>({
  id: "nooq.columns.place-beside", label: "Place beside",
  validateArgs: (a): a is PlaceBesideArgs => object(a) && typeof a.block === "string" && typeof a.target === "string"
    && (a.side === "left" || a.side === "right"),
  prepare(ctx, args) {
    const placement = columnPlacement(ctx.snapshot, ctx.parentOf, args);
    if (!placement) return { status: "not-applicable" };
    if (placement.kind === "reorder") return {
      status: "ready", intent: "move-column",
      ops: [{ op: "move", block: placement.moving, newParent: placement.group, index: placement.index }],
    };

    const added = ctx.createBlock(column.type);
    added.fields.collapseWhenEmpty = false;
    const ops: Op[] = [];
    if (placement.kind === "wrap") {
      const group = ctx.createBlock(columns.type);
      const anchor = ctx.createBlock(column.type);
      group.fields.collapseWhenEmpty = false;
      anchor.fields.collapseWhenEmpty = false;
      ops.push(
        { op: "insert", block: group, parent: placement.parent, index: placement.index },
        { op: "insert", block: anchor, parent: group.id },
        { op: "insert", block: added, parent: group.id, index: args.side === "left" ? 0 : 1 },
        { op: "move", block: args.target, newParent: anchor.id },
      );
    } else {
      const layout = ctx.snapshot.blocks[placement.group]!;
      const weights = columnWeights(layout);
      weights[added.id] = weights[placement.target] = weights[placement.target]! / 2;
      ops.push({ op: "insert", block: added, parent: layout.id, index: placement.index }, ...writeWidths(layout, weights));
    }
    ops.push({ op: "move", block: args.block, newParent: added.id });
    return { status: "ready", intent: PLACE_BESIDE_INTENT, ops };
  },
});
