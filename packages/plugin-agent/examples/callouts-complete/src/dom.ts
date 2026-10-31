import { defineDOMPlugin, type BlockViewContext, type BlockView } from "@nooq/plugins/dom";
import type { Immutable } from "@nooq/plugins";
import plugin from "./index.ts";

function toneLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  return JSON.stringify(value);
}

function mount(context: BlockViewContext): BlockView {
  const root = document.createElement("div");
  root.className = "seed-callout";
  root.dataset.block = context.block;

  const row = document.createElement("div");
  row.className = "seed-callout-row";

  const label = document.createElement("output");
  label.className = "seed-callout-tone";
  label.textContent = "";
  row.appendChild(label);

  const cycle = document.createElement("button");
  cycle.type = "button";
  cycle.className = "seed-callout-cycle";
  cycle.textContent = "Cycle callout tone";
  row.appendChild(cycle);

  root.appendChild(row);

  const text = context.mountText({ label: "Callout text" });
  root.appendChild(text.element);
  root.appendChild(context.children.element);

  const blockId = context.block;

  const syncTone = (): void => {
    const block = context.snapshot().blocks[blockId];
    if (!block) return;
    const value = (block as unknown as { fields: Record<string, unknown> }).fields["tone"];
    label.textContent = toneLabel(value);
    root.dataset.tone = toneLabel(value);
  };
  syncTone();

  cycle.addEventListener("click", () => {
    context.run("seed.callout.cycle-tone", { block: blockId });
  }, { signal: context.signal });

  const disposeChange = context.onChange(syncTone);

  return {
    element: root,
    update: syncTone,
    destroy() {
      disposeChange();
      text.destroy();
    },
  };
}

interface SnapshotShape {
  blocks: Record<string, Immutable<{ children: readonly string[] }>>;
  roots: readonly string[];
}

function findParent(state: SnapshotShape, id: string): string | null {
  const stack = [...state.roots];
  while (stack.length) {
    const current = stack.pop()!;
    const entry = state.blocks[current];
    if (!entry) continue;
    if (entry.children.includes(id)) return current;
    stack.push(...entry.children);
  }
  return null;
}

export default defineDOMPlugin({
  id: plugin.id,
  forPlugin: plugin,
  views: [{ type: "seed.callout/v1", mount }],
  menus: [
    {
      id: "seed.callout.insert",
      label: "Insert callout",
      command: "seed.callout.insert",
      args({ block, snapshot }) {
        const state = snapshot as unknown as SnapshotShape;
        const parent = findParent(state, block);
        const siblings = parent !== null && state.blocks[parent] ? state.blocks[parent].children : state.roots;
        const index = siblings.indexOf(block) + 1;
        return { parent, index, clearBlock: block };
      },
    },
  ],
});
