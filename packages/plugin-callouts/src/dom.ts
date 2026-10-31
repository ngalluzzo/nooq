import { defineDOMPlugin } from "@nooq/plugins/dom";
import { callout, callouts, cycleTone, insertCallout } from "./index.ts";

export const calloutsDOM = defineDOMPlugin({ id: "nooq.callouts", forPlugin: callouts,
  menus: [{ id: "insert-callout", label: "Callout", glyph: "!", command: insertCallout.id, args: ctx => {
    const parent = Object.values(ctx.snapshot.blocks).find(block => block.children.includes(ctx.block))?.id ?? null;
    const siblings = parent === null ? ctx.snapshot.roots : ctx.snapshot.blocks[parent]!.children;
    return { parent, index: siblings.indexOf(ctx.block) + 1, clearBlock: ctx.block };
  } }],
  views: [{ type: callout.type, mount(ctx) {
    const element = document.createElement("aside"), button = document.createElement("button"), status = document.createElement("span");
    element.className = "nq-callout";
    element.style.cssText = "border-inline-start:4px solid currentColor;padding:1rem;margin:.5rem 0";
    button.type = "button"; button.setAttribute("aria-label", "Cycle callout tone");
    button.textContent = "Cycle callout tone"; status.setAttribute("aria-live", "polite");
    button.addEventListener("click", () => ctx.run(cycleTone, { block: ctx.block }), { signal: ctx.signal });
    const text = ctx.mountText({ label: "Callout text" });
    element.append(button, status, text.element, ctx.children.element);
    return { element, update(block) { element.dataset.tone = String(block.fields.tone); status.textContent = `Tone: ${block.fields.tone}`; }, destroy: () => text.destroy() };
  } }],
});
