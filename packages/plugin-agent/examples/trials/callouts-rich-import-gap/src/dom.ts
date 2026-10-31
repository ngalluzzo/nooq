import { defineDOMPlugin, insertAfterSelection } from "@nooq/plugins/dom";
import type { Block, BlockViewContext, Immutable } from "@nooq/plugins/dom";
import plugin from "./index.ts";

function renderTone(root: HTMLElement, label: HTMLElement, value: HTMLElement, tone: unknown) {
  label.textContent = "Tone";
  value.textContent = typeof tone === "string" ? tone : "";
  root.dataset.tone = typeof tone === "string" ? tone : "invalid";
}

function mountCallout(context: BlockViewContext) {
  const root = document.createElement("div");
  root.className = "seed-callout";

  const label = document.createElement("span");
  label.className = "seed-callout__tone-label";
  root.appendChild(label);

  const toneValue = document.createElement("span");
  toneValue.className = "seed-callout__tone-value";
  root.appendChild(toneValue);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "seed-callout__cycle";
  button.textContent = "Cycle callout tone";
  root.appendChild(button);

  const rich = context.mountRichText({ label: "Callout text" });
  root.appendChild(rich.element);
  root.appendChild(context.children.element);

  renderTone(root, label, toneValue, context.snapshot().blocks[context.block]?.fields?.tone);
  const offChange = context.onChange(() => {
    renderTone(root, label, toneValue, context.snapshot().blocks[context.block]?.fields?.tone);
  });
  button.addEventListener("click", () => {
    context.run("seed.callout.cycle-tone", { block: context.block });
  });
  context.signal.addEventListener("abort", () => {
    offChange();
    rich.destroy();
  });

  return {
    element: root,
    update(block: Immutable<Block>) {
      renderTone(root, label, toneValue, block.fields.tone);
    },
    destroy() {
      offChange();
      rich.destroy();
    },
  };
}

export default defineDOMPlugin({
  id: plugin.id,
  forPlugin: plugin,
  views: [{ type: "seed.callout/v1", mount: mountCallout }],
  menus: [
    {
      id: "seed.callout.insert",
      label: "Insert callout",
      command: "seed.callout.insert",
      args: insertAfterSelection,
      glyph: "callout",
      hint: "Insert a callout",
    },
  ],
});
