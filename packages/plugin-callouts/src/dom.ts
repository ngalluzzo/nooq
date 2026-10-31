import { defineAction, defineDOMPlugin, insertAfterSelection } from "@nooq/plugins/dom";
import { callout, callouts, cycleTone, insertCallout } from "./index.ts";

export const insertCalloutAction = defineAction({ id: "insert-callout", label: "Callout", glyph: "!",
  command: insertCallout, args: insertAfterSelection, placements: ["slash"],
});
export const cycleToneAction = defineAction({ id: "cycle-callout-tone", label: "Cycle callout tone",
  command: cycleTone, args: ctx => ({ block: ctx.block }), placements: ["toolbar"], keys: ["Ctrl+Shift+Y"],
  when: ctx => ctx.snapshot.blocks[ctx.block]?.type === callout.type,
  enabled: ctx => callout.fields.tone.validate(ctx.snapshot.blocks[ctx.block]?.fields.tone) || "Choose a supported tone before cycling.",
});

function createCalloutsDOM(rich: boolean) { return defineDOMPlugin({ id: "nooq.callouts", forPlugin: callouts,
  actions: [insertCalloutAction, cycleToneAction],
  views: [{ type: callout.type, mount(ctx) {
    const element = document.createElement("aside"), status = document.createElement("span");
    element.className = "nq-callout";
    element.style.cssText = "border-inline-start:4px solid currentColor;padding:1rem;margin:.5rem 0";
    const toolbar = ctx.mountActionToolbar({ label: "Callout actions" });
    status.setAttribute("aria-live", "polite");
    const text = rich ? ctx.mountRichText({ label: "Callout text" }) : ctx.mountText({ label: "Callout text" });
    element.append(toolbar.element, status, text.element, ctx.children.element);
    return { element, update(block) { element.dataset.tone = String(block.fields.tone); status.textContent = `Tone: ${block.fields.tone}`; }, destroy: () => text.destroy() };
  } }],
}); }

export const calloutsDOM = createCalloutsDOM(true);
/** Compatibility surface for applications that still require a textarea. */
export const calloutsPlainDOM = createCalloutsDOM(false);
