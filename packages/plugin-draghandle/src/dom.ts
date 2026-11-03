/**
 * The drag handle's DOM half: one surface hook, no views. The handle is one
 * absolutely-positioned element beside the hovered row; the drop indicator
 * is one absolutely-positioned line. Pointer capture carries the drag; the
 * command carries the edit — this file owns gestures, never state.
 */
import { defineDOMPlugin, type SurfacePluginContext } from "@nooq/plugins/dom";
import { draghandle } from "./index.ts";

interface DropTarget { parent: string | null; index: number }

export const draghandleDOM = defineDOMPlugin({
  id: "nooq.draghandle.dom", forPlugin: draghandle,
  views: [],
  keys: [
    { id: "move-up", key: "Alt+ArrowUp", label: "Move block up", command: "nooq.block.move",
      args: ctx => keyboardTarget(ctx, -1), when: ctx => keyboardTarget(ctx, -1) !== null },
    { id: "move-down", key: "Alt+ArrowDown", label: "Move block down", command: "nooq.block.move",
      args: ctx => keyboardTarget(ctx, +1), when: ctx => keyboardTarget(ctx, +1) !== null },
  ],
  surface(context: SurfacePluginContext) {
    return mountHandle(context);
  },
});

/** The focused block's neighbor slot for Alt+arrows; null when immobile. */
function keyboardTarget(ctx: { block: string; snapshot: { roots: readonly string[]; blocks: Record<string, { children: readonly string[] }> } }, delta: -1 | 1): DropTarget | null {
  const id = ctx.block;
  const view = ctx.snapshot as unknown as { roots: readonly string[]; blocks: Record<string, { children: readonly string[] }> };
  const parent = Object.keys(view.blocks).find(pid => view.blocks[pid]!.children.includes(id)) ?? null;
  const siblings = parent === null ? view.roots : view.blocks[parent]!.children;
  const at = siblings.indexOf(id);
  if (at < 0) return null;
  const to = at + delta;
  if (to < 0 || to >= siblings.length) return null;
  // Swapping with the neighbor = moving to the neighbor's slot (past itself).
  return { parent, index: delta < 0 ? to : to };
}

function mountHandle({ root, signal, snapshot, run, report }: SurfacePluginContext): () => void {
  const handle = document.createElement("div");
  handle.className = "nq-draghandle";
  handle.setAttribute("role", "button");
  handle.setAttribute("aria-label", "Move block (drag, or Alt with arrow keys)");
  handle.tabIndex = 0;
  const indicator = document.createElement("div");
  indicator.className = "nq-drop-indicator";
  indicator.setAttribute("aria-hidden", "true");
  let hovered: HTMLElement | null = null;
  let dragging = false;

  const rowOf = (element: EventTarget | null): HTMLElement | null =>
    element instanceof Element ? element.closest<HTMLElement>("[data-nq-block]") : null;

  // The handle floats in the gutter beside the hovered row, relative to the
  // surface root (the root is position:relative for this purpose — one style,
  // the surface's own, no plugin reaches into the host's layout).
  const place = () => {
    if (!hovered || !hovered.isConnected) { handle.remove(); hovered = null; return; }
    const rect = hovered.getBoundingClientRect(), host = root.getBoundingClientRect();
    handle.style.left = "4px";
    handle.style.top = `${rect.top - host.top + root.scrollTop + rect.height / 2}px`;
    handle.style.transform = "translateY(-50%)";
    if (!handle.isConnected) root.append(handle);
  };

  const onMove = (event: PointerEvent) => {
    if (dragging) return;
    const row = rowOf(event.target);
    if (row === null || !root.contains(row)) { hovered = null; handle.remove(); return; }
    if (row !== hovered) { hovered = row; place(); }
  };

  /** Where the pointer says: between siblings (index) or nowhere legal. */
  const dropAt = (clientX: number, clientY: number, draggingId: string): DropTarget | null => {
    const elements = document.elementsFromPoint(clientX, clientY)
      .map(el => el instanceof Element ? el.closest<HTMLElement>("[data-nq-block]") : null)
      .filter((el): el is HTMLElement => el !== null && el.dataset.nqBlock !== draggingId && root.contains(el));
    const target = elements[0];
    if (!target) return null;
    const targetId = target.dataset.nqBlock!;
    const view = snapshot() as unknown as { roots: readonly string[]; blocks: Record<string, { children: readonly string[] }> };
    const parent = Object.keys(view.blocks).find(pid => view.blocks[pid]!.children.includes(targetId)) ?? null;
    const siblings = parent === null ? view.roots : view.blocks[parent]!.children;
    const rect = target.getBoundingClientRect();
    const before = clientY < rect.top + rect.height / 2;
    const at = siblings.indexOf(targetId);
    if (at < 0) return null;
    return { parent, index: before ? at : at + 1 };
  };

  const lineAt = (target: DropTarget) => {
    const view = snapshot() as unknown as { roots: readonly string[]; blocks: Record<string, { children: readonly string[] }> };
    const siblings = target.parent === null ? view.roots : view.blocks[target.parent]!.children;
    // The row the line sits before; at the end, after the last.
    const before = siblings[target.index];
    const row = before !== undefined ? root.querySelector<HTMLElement>(`[data-nq-block="${before}"]`)
      : Array.from(root.querySelectorAll<HTMLElement>("[data-nq-block]")).at(-1);
    if (!row) return;
    const rect = row.getBoundingClientRect(), host = root.getBoundingClientRect();
    const top = (before !== undefined ? rect.top : rect.bottom) - host.top + root.scrollTop;
    indicator.style.left = `${host.left + 16 - root.getBoundingClientRect().left}px`;
    indicator.style.width = `${Math.min(host.width - 16, rect.width || host.width - 32)}px`;
    indicator.style.top = `${top}px`;
    if (!indicator.isConnected) root.append(indicator);
  };

  const onDown = (event: PointerEvent) => {
    if (!(event.target instanceof Element && event.target.closest(".nq-draghandle")) || !hovered) return;
    const draggingId = hovered.dataset.nqBlock!;
    dragging = true;
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add("nq-draghandle-active");
    let target: DropTarget | null = null;
    const move = (e: PointerEvent) => { target = dropAt(e.clientX, e.clientY, draggingId); if (target) lineAt(target); else indicator.remove(); };
    const up = () => {
      handle.releasePointerCapture?.(event.pointerId);
      handle.classList.remove("nq-draghandle-active");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      indicator.remove();
      dragging = false;
      if (target) { const result = run("nooq.block.move", { block: draggingId, parent: target.parent, index: target.index }); if (result.status === "failed" || result.status === "denied") report(new Error(`Move failed: ${"reason" in result ? result.reason : result.status}`)); }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  root.addEventListener("pointermove", onMove, { signal });
  root.addEventListener("pointerdown", onDown, { signal });
  const onLeave = () => { if (!dragging) { hovered = null; handle.remove(); } };
  root.addEventListener("pointerleave", onLeave, { signal });
  return () => { handle.remove(); indicator.remove(); };
}
