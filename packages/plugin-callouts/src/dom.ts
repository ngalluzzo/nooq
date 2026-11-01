import { defineAction, defineDOMPlugin, defineTextPolicy, insertAfterSelection } from "@nooq/plugins/dom";
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
  views: [{ type: callout.type, ...(rich ? { textPolicy: defineTextPolicy({ defaultMode: "rich" }) } : {}), mount(ctx) {
    const element = document.createElement("aside"), status = document.createElement("span");
    element.className = "nq-callout";
    // The brand book rules out a colored side border: state lives in the tone
    // word above and the outline ("Radii, borders, shadows"). Plugins have no
    // block container yet, so this frame borrows the host theme's tokens —
    // a rule outline, token spacing — instead of drawing its own chrome.
    element.style.cssText = "border:1px solid var(--nq-rule);padding:var(--nq-space-4);margin:var(--nq-space-2) 0";
    const toolbar = ctx.mountActionToolbar({ label: "Callout actions" });
    status.setAttribute("aria-live", "polite");
    // rich variant: the policy-aware mount — mode and Enter behavior come
    // from the surface's textMode and this view's policy (rich by default).
    // plain variant: an EXPLICIT legacy textarea, which keeps its
    // presentation whatever the surface's textMode says.
    const text = rich ? ctx.mountTextEditor({ label: "Callout text" }) : ctx.mountText({ label: "Callout text" });
    element.append(toolbar.element, status, text.element, ctx.children.element);
    return { element, update(block) { element.dataset.tone = String(block.fields.tone); status.textContent = `Tone: ${block.fields.tone}`; }, destroy: () => text.destroy() };
  } }],
}); }

export const calloutsDOM = createCalloutsDOM(true);
/** Compatibility surface for applications that still require a textarea. */
export const calloutsPlainDOM = createCalloutsDOM(false);
