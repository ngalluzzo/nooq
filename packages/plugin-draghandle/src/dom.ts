/**
 * The drag handle's DOM half: one surface hook, no views, no overlay
 * positioning — the design system's .nq-handle button (in every row's
 * gutter, labeled "Move block") is the affordance; this plugin supplies
 * the BEHAVIOR: pointerdown on .nq-handle (delegated at the root) starts
 * the drag, the drop line says where it lands, release runs the command.
 * Gestures here, never state (§7: a plugin ships it).
 *
 * The keyboard path is the same command: Alt+Up/Alt+Down move the focused
 * block (§9 — the mouse is not the only door).
 */
import { defineDOMPlugin, type SurfacePluginContext } from "@nooq/plugins/dom";
import { draghandle } from "./index.ts";

interface DropTarget { parent: string | null; index: number }
type View = { roots: readonly string[]; blocks: Record<string, { children: readonly string[] }> };

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
    return attachGesture(context);
  },
});

/** The focused block's neighbor slot for Alt+arrows; null when immobile. */
function keyboardTarget(ctx: { block: string; snapshot: unknown }, delta: -1 | 1): DropTarget | null {
  const id = ctx.block;
  const view = ctx.snapshot as unknown as View;
  const parent = Object.keys(view.blocks).find(pid => view.blocks[pid]!.children.includes(id)) ?? null;
  const siblings = parent === null ? view.roots : view.blocks[parent]!.children;
  const at = siblings.indexOf(id);
  if (at < 0) return null;
  const to = at + delta;
  if (to < 0 || to >= siblings.length) return null;
  return { parent, index: to };
}

function attachGesture({ root, signal, snapshot, run, report }: SurfacePluginContext): () => void {
  const indicator = document.createElement("div");
  indicator.className = "nq-drop-indicator";
  indicator.setAttribute("aria-hidden", "true");

  /** Where the pointer says, walking past the dragged branch. */
  const dropAt = (clientX: number, clientY: number, draggingId: string): DropTarget | null => {
    const target = (document.elementsFromPoint(clientX, clientY)
      .map(el => el instanceof Element ? el.closest<HTMLElement>("[data-nq-block]") : null)
      .find(el => el !== null && el.dataset.nqBlock !== draggingId && root.contains(el)));
    if (!target) return null;
    const targetId = target.dataset.nqBlock!;
    const view = snapshot() as unknown as View;
    const parent = Object.keys(view.blocks).find(pid => view.blocks[pid]!.children.includes(targetId)) ?? null;
    const siblings = parent === null ? view.roots : view.blocks[parent]!.children;
    const at = siblings.indexOf(targetId);
    if (at < 0) return null;
    const rect = target.getBoundingClientRect();
    return { parent, index: clientY < rect.top + rect.height / 2 ? at : at + 1 };
  };

  /** The line: before the row at target.index, or after the last. */
  const lineAt = (target: DropTarget) => {
    const view = snapshot() as unknown as View;
    const siblings = target.parent === null ? view.roots : view.blocks[target.parent]!.children;
    const before = siblings[target.index];
    const row = before !== undefined
      ? root.querySelector<HTMLElement>(`[data-nq-block="${CSS.escape(before)}"]`)
      : Array.from(root.querySelectorAll<HTMLElement>("[data-nq-block]")).filter(el => root.contains(el)).at(-1);
    if (!row) return;
    const rect = row.getBoundingClientRect(), host = root.getBoundingClientRect();
    indicator.style.left = `${host.left + 16 - host.left}px`;
    indicator.style.width = `${Math.min(host.width - 16, rect.width || host.width - 32)}px`;
    indicator.style.top = `${(before !== undefined ? rect.top : rect.bottom) - host.top}px`;
    if (!indicator.isConnected) root.append(indicator);
  };

  const onDown = (event: PointerEvent) => {
    if (!(event.target instanceof Element && event.target.closest(".nq-handle"))) return;
    const row = event.target.closest<HTMLElement>("[data-nq-block]");
    if (!row) return;
    const draggingId = row.dataset.nqBlock!;
    const handle = event.target.closest<HTMLElement>(".nq-handle")!;
    event.preventDefault();
    handle.setPointerCapture?.(event.pointerId);
    handle.classList.add("nq-handle-active");
    let target: DropTarget | null = null;
    const move = (e: PointerEvent) => { target = dropAt(e.clientX, e.clientY, draggingId); if (target) lineAt(target); else indicator.remove(); };
    const up = () => {
      handle.releasePointerCapture?.(event.pointerId);
      handle.classList.remove("nq-handle-active");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      indicator.remove();
      if (target) {
        const result = run("nooq.block.move", { block: draggingId, parent: target.parent, index: target.index });
        if (result.status === "failed" || result.status === "denied") report(new Error(`Move failed: ${"reason" in result ? result.reason : result.status}`));
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  root.addEventListener("pointerdown", onDown, { signal });
  return () => { indicator.remove(); };
}
