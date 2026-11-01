import { blockContainer, defineAction, defineDOMPlugin, defineTextPolicy, insertAfterSelection, setBlockContainerTone, type ContainerTone } from "@nooq/plugins/dom";
import { callout, callouts, cycleTone, insertCallout } from "./index.ts";

export const insertCalloutAction = defineAction({ id: "insert-callout", label: "Callout", glyph: "!",
  command: insertCallout, args: insertAfterSelection, placements: ["slash"],
});
export const cycleToneAction = defineAction({ id: "cycle-callout-tone", label: "Cycle callout tone",
  command: cycleTone, args: ctx => ({ block: ctx.block }), placements: ["toolbar"], keys: ["Ctrl+Shift+Y"],
  when: ctx => ctx.snapshot.blocks[ctx.block]?.type === callout.type,
  enabled: ctx => callout.fields.tone.validate(ctx.snapshot.blocks[ctx.block]?.fields.tone) || "Choose a supported tone before cycling.",
});

/** Brand law: hue means an actor, so severity never tints the frame. The tone word carries the meaning. */
function containerTone(value: unknown): ContainerTone {
  return value === "success" ? "ink" : "neutral";
}

function createCalloutsDOM(rich: boolean) { return defineDOMPlugin({ id: "nooq.callouts", forPlugin: callouts,
  actions: [insertCalloutAction, cycleToneAction],
  views: [{ type: callout.type, ...(rich ? { textPolicy: defineTextPolicy({ defaultMode: "rich" }) } : {}), mount(ctx) {
    // The block container carries the frame; this view owns no styles of its
    // own. Tone maps per the brand book — info→neutral, success→ink,
    // warning→neutral — and the raw field stays visible as a word (§9).
    const initial = ctx.snapshot().blocks[ctx.block]?.fields.tone;
    const status = document.createElement("span");
    status.setAttribute("aria-live", "polite");
    status.textContent = `Tone: ${String(initial)}`;
    // rich variant: the policy-aware mount — mode and Enter behavior come
    // from the surface's textMode and this view's policy (rich by default).
    // plain variant: an EXPLICIT legacy textarea, which keeps its
    // presentation whatever the surface's textMode says.
    const text = rich ? ctx.mountTextEditor({ label: "Callout text" }) : ctx.mountText({ label: "Callout text" });
    const element = blockContainer({
      label: "Callout",
      tone: containerTone(initial),
      state: status,
      body: text.element,
      children: ctx.children.element,
      controls: ctx.mountActionToolbar({ label: "Callout actions" }).element,
    });
    return { element, update(block) { setBlockContainerTone(element, containerTone(block.fields.tone)); status.textContent = `Tone: ${String(block.fields.tone)}`; }, destroy: () => text.destroy() };
  } }],
}); }

export const calloutsDOM = createCalloutsDOM(true);
/** Compatibility surface for applications that still require a textarea. */
export const calloutsPlainDOM = createCalloutsDOM(false);
