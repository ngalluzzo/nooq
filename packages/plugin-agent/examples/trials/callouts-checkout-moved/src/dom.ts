import { defineDOMPlugin } from "@nooq/plugins/dom";
import plugin from "./index.ts";
import type { BlockViewContext, BlockView } from "@nooq/plugins/dom";

const cycleCommand = "seed.callout.cycle-tone";
const insertCommand = "seed.callout.insert";

function mountView(ctx: BlockViewContext): BlockView {
  const element = document.createElement("div");
  element.dataset.blockType = "seed.callout";

  const toneLabel = document.createElement("span");
  toneLabel.className = "callout-tone";
  toneLabel.setAttribute("aria-live", "polite");
  element.appendChild(toneLabel);

  const textBinding = ctx.mountText({ label: "Callout text" });
  element.appendChild(textBinding.element);

  const cycleBtn = document.createElement("button");
  cycleBtn.type = "button";
  cycleBtn.textContent = "Cycle callout tone";
  cycleBtn.addEventListener(
    "click",
    () => {
      ctx.run(cycleCommand, { block: ctx.block });
    },
    { signal: ctx.signal },
  );
  element.appendChild(cycleBtn);

  const childrenContainer = document.createElement("div");
  childrenContainer.className = "callout-children";
  childrenContainer.appendChild(ctx.children.element);
  element.appendChild(childrenContainer);

  function updateToneDisplay(tone: unknown) {
    toneLabel.textContent = typeof tone === "string" ? tone : String(tone);
  }

  const unsubscribe = ctx.onChange(() => {
    const snap = ctx.snapshot();
    const stored = snap.blocks[ctx.block];
    if (stored) updateToneDisplay(stored.fields.tone);
  });

  updateToneDisplay(ctx.snapshot().blocks[ctx.block]?.fields.tone);

  return {
    element,
    update(block) {
      updateToneDisplay(block.fields.tone);
    },
    destroy() {
      unsubscribe();
      textBinding.destroy();
    },
  };
}

export default defineDOMPlugin({
  id: plugin.id,
  forPlugin: plugin,
  views: [{ type: "seed.callout/v1", mount: mountView }],
  menus: [
    {
      id: "insert-callout",
      label: "Insert callout",
      command: insertCommand,
      args: ({ block, snapshot }) => {
        const parent = snapshot.roots.includes(block) ? null : snapshot.roots[0] ?? null;
        const siblings = parent
          ? snapshot.blocks[parent]?.children ?? []
          : snapshot.roots;
        const index = siblings.indexOf(block);
        return { parent, index: index === -1 ? undefined : index, clearBlock: block };
      },
    },
  ],
});
