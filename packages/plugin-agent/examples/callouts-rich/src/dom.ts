import type { Block } from "@nooq/plugins";
import { defineDOMPlugin, insertAfterSelection, type BlockView, type BlockViewContext } from "@nooq/plugins/dom";
import plugin from "./index.ts";

const VALID_TONES = new Set(["info", "warning", "success"]);

function mountCallout(ctx: BlockViewContext): BlockView {
  const root = document.createElement("div");
  root.className = "seed-callout";

  const toneButton = document.createElement("button");
  toneButton.type = "button";
  toneButton.textContent = "Cycle callout tone";
  root.appendChild(toneButton);

  const toneLabel = document.createElement("span");
  toneLabel.className = "seed-callout__tone";
  root.appendChild(toneLabel);

  const rich = ctx.mountRichText({ label: "Callout text" });
  root.appendChild(rich.element);
  root.appendChild(ctx.children.element);

  const update = (block: Block) => {
    const tone = block.fields.tone;
    const valid = typeof tone === "string" && VALID_TONES.has(tone);
    toneLabel.textContent = String(tone ?? "");
    toneLabel.dataset.valid = valid ? "true" : "false";
    root.dataset.tone = valid ? (tone as string) : "invalid";
  };

  toneButton.addEventListener(
    "click",
    () => {
      ctx.run("seed.callout.cycle-tone", { block: ctx.block });
    },
    { signal: ctx.signal },
  );

  return {
    element: root,
    update,
    destroy: () => rich.destroy(),
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
    },
  ],
});
