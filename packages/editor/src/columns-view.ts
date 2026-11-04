import { button } from "@nooq/design";
import type { Block } from "@nooq/core";
import type { Immutable } from "@nooq/plugins";
import type { BlockView, BlockViewContext } from "@nooq/plugins/dom";
import { column, columnWeights, insertBlock, layoutColumns, MAX_LAYOUT_COLUMNS, MIN_LAYOUT_COLUMN_WIDTH, paragraph, resizeColumns } from "@nooq/plugins/essentials";

export function mountColumns(ctx: BlockViewContext): BlockView {
  const element = document.createElement("div");
  element.className = "nq-columns";
  const grid = ctx.children.element;
  element.append(grid);
  let block: Immutable<Block> | undefined;
  const handles: HTMLElement[] = [];
  let drag: {
    handle: HTMLElement; pointer: number; index: number; x: number;
    width: number; tracks: number[]; signature: string; share?: number;
  } | undefined;

  const lanes = (value: Immutable<Block>) => layoutColumns(ctx.snapshot(), value);
  const signature = (value: Immutable<Block>) => JSON.stringify([lanes(value), value.fields.widths]);
  const gap = () => parseFloat(getComputedStyle(grid).columnGap) || 24;
  const tracks = () => getComputedStyle(grid).gridTemplateColumns.split(" ").map(parseFloat);
  const cancel = () => {
    const old = drag;
    drag = undefined;
    if (old?.handle.hasPointerCapture?.(old.pointer)) old.handle.releasePointerCapture(old.pointer);
    old?.handle.classList.remove("is-resizing");
  };

  function paintHandles(pixels: number[], spacing: number) {
    let edge = -spacing / 2;
    handles.forEach((handle, i) => {
      const first = pixels[i], second = pixels[i + 1];
      if (first === undefined || second === undefined || !Number.isFinite(first + second)) return;
      const ratio = (value: number) => Math.round(100 * value / (first + second));
      const min = ratio(MIN_LAYOUT_COLUMN_WIDTH);
      const value = ratio(first);
      edge += first + spacing;
      handle.style.insetInlineStart = `${edge}px`;
      handle.setAttribute("aria-valuemin", String(min));
      handle.setAttribute("aria-valuemax", String(100 - min));
      handle.setAttribute("aria-valuenow", String(value));
      handle.setAttribute("aria-valuetext", `${value}% first column, ${100 - value}% second column`);
    });
  }

  function layout() {
    if (!block || drag) return;
    const visible = lanes(block);
    const count = visible.length;
    const supported = count >= 2 && count <= MAX_LAYOUT_COLUMNS &&
      visible.every(id => ctx.snapshot().blocks[id]?.type === column.type);
    const width = grid.clientWidth, spacing = gap();
    const stacked = !supported || (width > 0 && width < count * MIN_LAYOUT_COLUMN_WIDTH + (count - 1) * spacing);
    const previousStack = element.hasAttribute("data-nq-columns-stacked");
    const stackChanged = element.toggleAttribute("data-nq-columns-stacked", stacked) !== previousStack;
    const weights = columnWeights(block);
    if (stacked) grid.style.removeProperty("grid-template-columns");
    else grid.style.setProperty("grid-template-columns", visible.map(id => `minmax(${MIN_LAYOUT_COLUMN_WIDTH}px, ${weights[id]}fr)`).join(" "));
    const measured = !stacked && width > 0;
    for (const handle of handles) handle.hidden = !measured;
    if (measured) paintHandles(tracks(), spacing);
    if (stackChanged && width > 0) element.dispatchEvent(new Event("nooq:column-flow", { bubbles: true }));
  }

  function commit(index: number, share: number) {
    if (!block) return;
    const visible = lanes(block);
    const left = visible[index], right = visible[index + 1];
    if (!left || !right) return;
    const result = ctx.run(resizeColumns, { group: ctx.block, left, right, share });
    if (result.status === "failed") ctx.report(result.error);
    if (result.status === "denied") ctx.report(new Error(result.reason));
  }

  function addHandle(index: number) {
    const handle = document.createElement("div");
    handle.tabIndex = 0;
    handle.className = "nq-column-resize";
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", `Resize columns ${index + 1} and ${index + 2}`);
    handle.setAttribute("aria-orientation", "vertical");
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag || !block) return;
      const widths = tracks();
      if (!Number.isFinite(widths[index]! + widths[index + 1]!)) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      handle.setPointerCapture?.(event.pointerId);
      handle.classList.add("is-resizing");
      drag = { handle, pointer: event.pointerId, index, x: event.clientX, width: grid.clientWidth, tracks: widths, signature: signature(block) };
    }, { signal: ctx.signal });
    handle.addEventListener("pointermove", event => {
      if (drag?.pointer !== event.pointerId || drag.handle !== handle) return;
      const widths = [...drag.tracks], total = widths[index]! + widths[index + 1]!;
      const direction = getComputedStyle(grid).direction === "rtl" ? -1 : 1;
      const left = Math.max(MIN_LAYOUT_COLUMN_WIDTH, Math.min(total - MIN_LAYOUT_COLUMN_WIDTH, widths[index]! + (event.clientX - drag.x) * direction));
      drag.share = Math.abs(left - widths[index]!) > .5 ? left / total : undefined;
      widths[index] = left;
      widths[index + 1] = total - left;
      grid.style.setProperty("grid-template-columns", widths.map(width => `${width}px`).join(" "));
      paintHandles(widths, gap());
    }, { signal: ctx.signal });
    const finish = (event: PointerEvent) => {
      if (drag?.pointer !== event.pointerId || drag.handle !== handle) return;
      const pending = drag;
      const current = ctx.snapshot().blocks[ctx.block];
      cancel();
      layout();
      if (event.type === "pointerup" && pending.share !== undefined && current
        && signature(current) === pending.signature && grid.clientWidth === pending.width) commit(index, pending.share);
    };
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) handle.addEventListener(event, finish, { signal: ctx.signal });
    handle.addEventListener("keydown", event => {
      if (event.key === "Escape" && drag) {
        event.preventDefault();
        cancel();
        layout();
        return;
      }
      if (drag || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const [first, second] = tracks().slice(index, index + 2);
      const total = first! + second!;
      if (!Number.isFinite(total) || total <= MIN_LAYOUT_COLUMN_WIDTH * 2) return;
      event.preventDefault();
      const direction = getComputedStyle(grid).direction === "rtl" ? -1 : 1;
      const next = Math.max(MIN_LAYOUT_COLUMN_WIDTH, Math.min(total - MIN_LAYOUT_COLUMN_WIDTH, first! + (event.key === "ArrowLeft" ? -.05 : .05) * total * direction));
      if (Math.abs(next - first!) > .5) commit(index, next / total);
    }, { signal: ctx.signal });
    handles.push(handle);
    element.append(handle);
  }

  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
    if (drag && grid.clientWidth !== drag.width) cancel();
    layout();
  }) : undefined;
  observer?.observe(grid);
  return {
    element,
    update(next) {
      if (drag && drag.signature !== signature(next)) cancel();
      block = next;
      const count = Math.min(MAX_LAYOUT_COLUMNS, lanes(next).length);
      while (handles.length > Math.max(0, count - 1)) handles.pop()!.remove();
      while (handles.length < count - 1) addHandle(handles.length);
      layout();
    },
    destroy() { cancel(); observer?.disconnect(); },
  };
}

export function mountColumn(ctx: BlockViewContext): BlockView {
  const element = document.createElement("div");
  element.className = "nq-column";
  const empty = button({ label: "Add text", variant: "quiet", onClick: () => {
    const result = ctx.run(insertBlock, { type: paragraph.type, parent: ctx.block });
    if (result.status === "failed") ctx.report(result.error);
    if (result.status === "denied") ctx.report(new Error(result.reason));
    if (result.status === "applied" && result.selection) {
      const id = result.selection.block;
      queueMicrotask(() => element.querySelector<HTMLElement>(`[data-nq-block="${CSS.escape(id)}"] :is(textarea, [contenteditable="true"])`)?.focus());
    }
  } });
  empty.classList.add("nq-column-empty");
  element.append(ctx.children.element, empty);
  return { element, update(block) { empty.hidden = block.children.length > 0; } };
}
