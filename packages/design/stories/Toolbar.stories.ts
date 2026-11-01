import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { defineAction, defineDOMPlugin, type Action } from "../../plugins/src/dom.ts";
import { callout, callouts, cycleTone, insertCallout } from "../../plugin-callouts/src/index.ts";
import { stateTag } from "../src/index.ts";

/**
 * The action toolbar's visual contract (foundation.md P0). The editor owns the
 * behavior — roving focus, disabled reasons, the status region — and mounts it
 * with theme classes only; these stories pin what those classes draw. The
 * harness is the same one as Plugins/Shared actions: a callout whose view
 * mounts ctx.mountActionToolbar.
 */

const editors = new Set<Editor>();
const fixtures = new WeakMap<HTMLElement, { editor: Editor; id: string }>();
function mountToolbar(actions: readonly Action[]): HTMLElement {
  const dom = defineDOMPlugin({ id: "toolbar-story", forPlugin: callouts, actions, views: [{ type: callout.type, mount(ctx) {
    const element = document.createElement("div");
    const toolbar = ctx.mountActionToolbar({ label: "Callout actions" });
    // A view may append its own controls to the toolbar; the .nq-action-separator
    // rule then sets them apart from the actions (hidden while nothing trails it).
    toolbar.element.append(stateTag({ state: "fresh" }));
    element.append(toolbar.element, ctx.children.element);
    return { element, update() {} };
  } }] });
  const editor = new Editor({ docId: "toolbar-story", actor: { actorId: "writer" }, plugins: [callouts] });
  editors.add(editor);
  const inserted = editor.commands.run(insertCallout, { parent: null });
  if (inserted.status !== "applied") throw new Error(inserted.status);
  const id = inserted.selection!.block;
  editor.editText(id, "A useful note");
  const surface = createSurface(editor, { plugins: [dom] });
  surface.element.dataset.toolbarDemo = "true";
  fixtures.set(surface.element, { editor, id });
  return surface.element;
}

const base = { command: cycleTone, args: (ctx: { block: string }) => ({ block: ctx.block }), placements: ["toolbar"] as const };
const hinted = defineAction({ ...base, id: "story-cycle", label: "Cycle callout tone", hint: "⌘⇧Y" });
const plain = defineAction({ ...base, id: "story-plain", label: "Cycle callout tone" });
const second = defineAction({ ...base, id: "story-duplicate", label: "Duplicate" });
const blocked = defineAction({ ...base, id: "story-blocked", label: "Cycle callout tone", enabled: () => "Choose a supported tone before cycling." });

const meta = {
  title: "Plugins/Action toolbar",
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  parameters: {
    docs: {
      description: {
        component:
          "What `ctx.mountActionToolbar` draws, pinned from a real editor surface. Buttons reuse `.nq-btn` at control-md; a disabled action states its reason as a word wired through `aria-describedby`; a repeated action shows its shortcut as a kbd chip (§9). Views append their own controls after the `.nq-action-separator` rule. Overflow into a menu arrives with the popover.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const Enabled: Story = {
  render: () => mountToolbar([hinted, second]),
  play: async ({ canvas, userEvent }) => {
    const toolbar = canvas.getByRole("toolbar", { name: "Callout actions" });
    const cycleButton = canvas.getByRole("button", { name: /Cycle callout tone/ });
    // The buttons are the system's buttons: control-md height, focus ring, kbd hint.
    await expect(cycleButton.classList.contains("nq-btn")).toBe(true);
    await expect(cycleButton.querySelector("kbd.nq-kbd")?.textContent).toBe("⌘⇧Y");
    await expect(cycleButton).toHaveAttribute("title", "⌘⇧Y");
    // This view appended a state tag, so the separator rule shows before it.
    const separator = toolbar.querySelector<HTMLElement>(".nq-action-separator")!;
    await expect(getComputedStyle(separator).display).not.toBe("none");
    // Appended content changes nothing about roving focus (§9).
    cycleButton.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("button", { name: "Duplicate" })).toHaveFocus();
    await expect(canvas.getByRole("button", { name: "Duplicate" }).tabIndex).toBe(0);
    await expect(cycleButton.tabIndex).toBe(-1);
  },
};

export const DisabledWithReason: Story = {
  render: () => mountToolbar([blocked]),
  play: async ({ canvas }) => {
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription("Choose a supported tone before cycling.");
    const reason = document.getElementById(button.getAttribute("aria-describedby")!)!;
    await expect(reason.className).toContain("nq-action-reason");
    await expect(reason.textContent).toBe("Choose a supported tone before cycling.");
  },
};

export const WithoutHint: Story = {
  render: () => mountToolbar([plain]),
  play: async ({ canvas }) => {
    const button = canvas.getByRole("button", { name: "Cycle callout tone" });
    await expect(button).toBeEnabled();
    await expect(button.querySelector("kbd")).toBeNull();
    await expect(button).toHaveAttribute("title", "");
    await expect(button.getAttribute("aria-describedby")).toBeNull();
  },
};
