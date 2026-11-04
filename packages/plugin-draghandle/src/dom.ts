import { liveTree, type DocState } from "@nooq/core";
import { button, popover, selectField, type FieldOption, type PopoverHandle } from "@nooq/design";
import { defineDOMPlugin, type SurfacePluginContext } from "@nooq/plugins/dom";
import { column, columns, columnPlacement, layoutColumns, MIN_LAYOUT_COLUMN_WIDTH, placeBeside, type PlaceBesideArgs } from "@nooq/plugins/essentials";
import { draghandle } from "./index.ts";

type DropTarget =
  | { kind: "vertical"; parent: string | null; index: number; rect: DOMRect; after: boolean }
  | { kind: "side"; args: PlaceBesideArgs; rect: DOMRect; right: boolean };

const tablePart = (type: string | undefined) => type === "nooq.table-row/v1" || type === "nooq.table-cell/v1";

export const draghandleDOM = defineDOMPlugin({
  id: "nooq.draghandle.dom", forPlugin: draghandle,
  views: [],
  keys: [
    { id: "move-up", key: "Alt+ArrowUp", label: "Move block up", command: "nooq.block.move",
      args: ctx => keyboardTarget(ctx, -1), when: ctx => keyboardTarget(ctx, -1) !== null },
    { id: "move-down", key: "Alt+ArrowDown", label: "Move block down", command: "nooq.block.move",
      args: ctx => keyboardTarget(ctx, +1), when: ctx => keyboardTarget(ctx, +1) !== null },
  ],
  surface: attachGesture,
});

function keyboardTarget(ctx: { block: string; snapshot: unknown }, delta: -1 | 1) {
  const view = ctx.snapshot as DocState;
  const parent = liveTree(view).parentOf.get(ctx.block);
  if (parent === undefined) return null;
  const siblings = parent === null ? view.roots : view.blocks[parent]!.children;
  const index = siblings.indexOf(ctx.block) + delta;
  return index < 0 || index >= siblings.length ? null : { parent, index };
}

function attachGesture({ root, signal, snapshot, run, report }: SurfacePluginContext): () => void {
  const indicator = document.createElement("div");
  indicator.className = "nq-drop-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const rowFor = (id: string) => root.querySelector<HTMLElement>(`[data-nq-block="${CSS.escape(id)}"]:not([data-nq-ph])`);
  let cached: ReturnType<typeof snapshot> | undefined;
  let parents: ReturnType<typeof liveTree>["parentOf"];
  const state = () => {
    const view = snapshot();
    if (cached !== view) { cached = view; parents = liveTree(view as DocState).parentOf; }
    return view;
  };
  let picker: PopoverHandle | undefined;
  let drag: { handle: HTMLElement; row: HTMLElement; block: string; pointer: number; x: number; y: number; active: boolean } | undefined;
  let suppressClick: HTMLElement | undefined;

  const sideFor = (right: boolean): PlaceBesideArgs["side"] =>
    right !== (getComputedStyle(root).direction === "rtl") ? "right" : "left";

  function dropAt(event: PointerEvent, gesture: NonNullable<typeof drag>): DropTarget | undefined {
    const { clientX: x, clientY: y } = event;
    let target = root.ownerDocument.elementsFromPoint(x, y)
      .map(el => el.closest<HTMLElement>("[data-nq-block]:not([data-nq-ph])"))
      .find(el => el && root.contains(el) && !gesture.row.contains(el));
    if (!target) return;
    const view = state();
    const sourceParent = parents.get(gesture.block);
    if (sourceParent === undefined) return;
    const movingTablePart = tablePart(view.blocks[gesture.block]?.type);
    if (!movingTablePart && tablePart(view.blocks[target.dataset.nqBlock!]?.type)) {
      target = target.closest(".nq-table")?.closest<HTMLElement>("[data-nq-block]") ?? undefined;
      if (!target || gesture.row.contains(target)) return;
    }
    const layout = view.blocks[target.dataset.nqBlock!];
    if (layout?.type === columns.type && target.querySelector(":scope > .nq-columns:not([data-nq-columns-stacked])")) {
      // A hit in the gutter belongs to the closest lane's edge.
      let distance = 13;
      for (const lane of layout.children) {
        const row = rowFor(lane);
        if (!row || gesture.row.contains(row)) continue;
        const bounds = row.getBoundingClientRect();
        const edge = Math.min(Math.abs(x - bounds.left), Math.abs(x - bounds.right));
        if (y >= bounds.top && y <= bounds.bottom && edge < distance) { distance = edge; target = row; }
      }
    }
    const id = target.dataset.nqBlock!;
    const parent = parents.get(id);
    if (parent === undefined) return;
    // Table rows and cells can reorder in their own container. Dragging an
    // ordinary block over a table targets the whole table as a block.
    if (movingTablePart && (parent !== sourceParent || view.blocks[id]?.type !== view.blocks[gesture.block]?.type)) return;
    const rect = target.getBoundingClientRect();
    const type = view.blocks[id]!.type;
    const laneRow = target.closest(".nq-column")?.closest("[data-nq-block]") ?? target;
    const edgeRect = laneRow.getBoundingClientRect();
    const band = Math.min(26, edgeRect.width * .2), end = Math.min(12, rect.height * .23);
    const center = y >= rect.top + end && y <= rect.bottom - end;
    const nearLeft = x >= edgeRect.left - 12 && x <= edgeRect.left + band;
    const nearRight = x <= edgeRect.right + 12 && x >= edgeRect.right - band;
    if (center && (nearLeft || nearRight)) {
      const args = { block: gesture.block, target: id, side: sideFor(nearRight) };
      const side = columnPlacement(view, block => parents.get(block), args);
      if (side) {
        const group = side.kind === "wrap" ? undefined : rowFor(side.group)?.querySelector<HTMLElement>(":scope > .nq-columns");
        const count = side.kind === "wrap" ? 2 : layoutColumns(view, view.blocks[side.group]!).length + Number(side.kind === "add");
        const gap = parseFloat(getComputedStyle(root).getPropertyValue("--nq-column-gap")) || 24;
        if ((group?.clientWidth ?? rect.width) >= count * MIN_LAYOUT_COLUMN_WIDTH + (count - 1) * gap) {
          const lane = rowFor(side.target)?.getBoundingClientRect() ?? rect;
          return { kind: "side", args, rect: lane, right: nearRight };
        }
      }
    }

    if (type === column.type) {
      const children = view.blocks[id]!.children;
      const last = children.at(-1);
      const index = children.length - Number(parents.get(gesture.block) === id);
      return { kind: "vertical", parent: id, index, rect: (last && rowFor(last)?.getBoundingClientRect()) || rect, after: true };
    }
    if (parent !== null && gesture.row.contains(rowFor(parent) ?? target)) return;
    const siblings = parent === null ? view.roots : view.blocks[parent]!.children;
    const at = siblings.indexOf(id);
    const after = y >= rect.top + rect.height / 2;
    const boundary = at + Number(after);
    const index = boundary - Number(parents.get(gesture.block) === parent && siblings.indexOf(gesture.block) < boundary);
    return { kind: "vertical", parent, index, rect, after };
  }

  function paint(target: DropTarget | undefined) {
    if (!target) { indicator.remove(); return; }
    const { rect } = target, host = root.getBoundingClientRect();
    const side = target.kind === "side";
    indicator.classList.toggle("is-side", side);
    indicator.style.left = `${(side && target.right ? rect.right : rect.left) - host.left}px`;
    indicator.style.top = `${(!side && target.after ? rect.bottom : rect.top) - host.top}px`;
    indicator.style.width = side ? "" : `${rect.width}px`;
    indicator.style.height = side ? `${rect.height}px` : "";
    if (!indicator.isConnected) root.append(indicator);
  }

  function place(args: PlaceBesideArgs) {
    const result = run(placeBeside, args);
    if (result.status === "failed") report(result.error);
    if (result.status === "denied") report(new Error(result.reason));
  }

  function openPicker(handle: HTMLElement, block: string) {
    picker?.destroy();
    const view = state();
    const options: FieldOption[] = [];
    const allowed = (target: string, right: boolean) =>
      columnPlacement(state(), id => parents.get(id), { block, target, side: sideFor(right) }) !== undefined;
    for (const row of Array.from(root.querySelectorAll<HTMLElement>("[data-nq-block]:not([data-nq-ph])"))) {
      const id = row.dataset.nqBlock!;
      if (!allowed(id, false) && !allowed(id, true)) continue;
      const candidate = view.blocks[id]!;
      const parent = parents.get(id);
      const label = candidate.type === column.type && parent ? `Column ${view.blocks[parent]!.children.indexOf(id) + 1}` : candidate.type;
      options.push({ label: (candidate.text?.s.trim() || label).slice(0, 64), value: id });
    }
    if (!options.length) return;
    const field = selectField({ label: "Target block", options, onInput: () => refresh() });
    const select = field.querySelector("select")!;
    const content = document.createElement("div");
    content.className = "nq-side-placement";
    const actions = document.createElement("div");
    actions.className = "nq-side-placement-actions";
    const left = button({ label: "Place left", onClick: () => choose(false) });
    const right = button({ label: "Place right", onClick: () => choose(true) });
    const refresh = () => { left.disabled = !allowed(select.value, false); right.disabled = !allowed(select.value, true); };
    const choose = (right: boolean) => {
      if (!allowed(select.value, right)) { refresh(); return; }
      picker?.destroy();
      picker = undefined;
      place({ block, target: select.value, side: sideFor(right) });
      queueMicrotask(() => handle.focus({ preventScroll: true }));
    };
    refresh();
    actions.append(left, right);
    content.append(field, actions);
    picker = popover({ anchor: handle, content, role: "dialog", focus: false, onClose: () => { picker = undefined; } });
    picker.element.setAttribute("aria-label", "Place block beside");
    root.append(picker.element);
    select.focus();
  }

  const gripFor = (event: Event) =>
    event.target instanceof Element ? event.target.closest<HTMLElement>(".nq-handle") : null;

  function stop(event?: PointerEvent) {
    if (!drag) return;
    const gesture = drag;
    drag = undefined;
    gesture.handle.classList.remove("nq-handle-active");
    if (gesture.handle.hasPointerCapture?.(gesture.pointer)) gesture.handle.releasePointerCapture(gesture.pointer);
    indicator.remove();
    if (!gesture.active) return;
    suppressClick = gesture.handle;
    setTimeout(() => { if (suppressClick === gesture.handle) suppressClick = undefined; }, 0);
    if (!event || !gesture.row.isConnected) return;
    const target = dropAt(event, gesture);
    if (!target) return;
    if (target.kind === "side") {
      place(target.args);
      queueMicrotask(() => gesture.handle.focus({ preventScroll: true }));
      return;
    }
    const result = run("nooq.block.move", { block: gesture.block, parent: target.parent, index: target.index });
    if (result.status === "failed") report(result.error);
    if (result.status === "denied") report(new Error(result.reason));
  }

  root.addEventListener("pointerdown", event => {
    const handle = gripFor(event);
    const row = handle?.closest<HTMLElement>("[data-nq-block]");
    if (event.button !== 0 || drag || !handle || !row) return;
    drag = { handle, row, block: row.dataset.nqBlock!, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    handle.setPointerCapture?.(event.pointerId);
  }, { signal });
  root.addEventListener("pointermove", event => {
    if (drag?.pointer !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    if (!drag.active) {
      picker?.destroy();
      picker = undefined;
      drag.active = true;
      drag.handle.classList.add("nq-handle-active");
    }
    paint(dropAt(event, drag));
  }, { signal });
  root.addEventListener("pointerup", event => { if (drag?.pointer === event.pointerId) stop(event); }, { signal });
  for (const event of ["pointercancel", "lostpointercapture"] as const) {
    root.addEventListener(event, e => { if (drag?.pointer === e.pointerId) stop(); }, { signal });
  }
  root.addEventListener("keydown", event => { if (event.key === "Escape" && drag) stop(); }, { signal });
  root.addEventListener("click", event => {
    const handle = gripFor(event);
    const id = handle?.closest<HTMLElement>("[data-nq-block]")?.dataset.nqBlock;
    if (!handle || !id || handle === suppressClick) return;
    openPicker(handle, id);
  }, { signal });

  return () => { stop(); picker?.destroy(); indicator.remove(); };
}
