import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor, within } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { referenceDOM, referenceJobBindings, referencePlugins } from "../../editor/src/reference.ts";
import { paragraph } from "../../plugins/src/essentials.ts";
import { collectShortcuts } from "../../editor/src/shortcuts.ts";
import { button, popover, resolveColor, shortcutSheet, type PopoverHandle, type ShortcutSheetGroup, type Tokens } from "../src/index.ts";
import tokensJson from "../tokens.json";

const tokens = tokensJson as Tokens;

/** "#6b7280" → "rgb(107, 114, 128)", as getComputedStyle reports it. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** A group's name, resolved the way assistive tech does: aria-labelledby → the visible title. */
function groupName(group: HTMLElement): string {
  return (group.getAttribute("aria-labelledby") ?? "")
    .split(" ")
    .map(id => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
}

/**
 * The shortcut sheet (foundation P2): the keyboard reference, generated from
 * registered actions and keymaps so it can't drift. `shortcutSheet` is content
 * only — the consumer collects the groups and wraps it in a popover. The
 * editor surface does both: "?" outside the input path opens it, refreshed
 * from the live registry at open time. Keys render verbatim ("Ctrl+Shift+K"
 * style), one chip per registered chord.
 */

const editors = new Set<Editor>();
const surfaces = new WeakMap<HTMLElement, ReturnType<typeof createSurface>>();

/** Representative groups, the same shapes the editor's collector produces. */
const GROUPS: readonly ShortcutSheetGroup[] = [
  { title: "Text editing", entries: [
    { label: "Bold", keys: ["Ctrl+B", "Meta+B"] },
    { label: "Italic", keys: ["Ctrl+I", "Meta+I"] },
    { label: "Code", keys: ["Ctrl+`", "Meta+`"] },
    { label: "Link", keys: ["Ctrl+K", "Meta+K"] },
  ] },
  { title: "Block actions", entries: [
    { label: "Split block", keys: ["Enter"] },
    { label: "Delete empty block", keys: ["Backspace"] },
    { label: "Cycle callout tone", keys: ["Ctrl+Shift+Y"] },
  ] },
  { title: "Tools", entries: [
    { label: "Summarize", keys: ["Ctrl+Shift+9"] },
  ] },
];

/** A trigger button opening the sheet in a popover — how a host mounts it. */
function sheetHost(groups: readonly ShortcutSheetGroup[]): HTMLElement {
  const page = document.createElement("div");
  page.className = "nq-doc";
  page.style.maxWidth = "var(--nq-measure)"; // story-only framing; components never size themselves inline
  let handle: PopoverHandle | undefined;
  const trigger = button({ label: "Keyboard shortcuts", onClick: () => {
    if (handle) { handle.destroy(); handle = undefined; return; }
    handle = popover({ anchor: trigger, side: "bottom", content: shortcutSheet({ groups }), onClose: () => { handle = undefined; } });
    handle.element.setAttribute("aria-label", "Keyboard shortcuts");
    document.body.append(handle.element);
  } });
  page.append(trigger);
  return page;
}

/** The real surface: the same reference plugins and DOM as the editor's other stories. */
function editorHost(): { page: HTMLElement; surface: ReturnType<typeof createSurface> } {
  const editor = new Editor({ docId: `shortcuts-story-${crypto.randomUUID()}`, actor: { actorId: "human:story", name: "Maya" }, plugins: referencePlugins, jobBindings: referenceJobBindings() });
  editors.add(editor);
  const surface = createSurface(editor, { plugins: referenceDOM, textMode: "rich" });
  editor.insertBlock({ type: paragraph.type, parent: null, text: "Maya writes in ink." });
  const page = document.createElement("div");
  page.className = "nq-doc";
  page.style.maxWidth = "var(--nq-measure)"; // story-only framing; components never size themselves inline
  page.append(surface.element);
  surfaces.set(surface.element, surface);
  return { page, surface };
}

const meta = {
  title: "Components/Shortcut sheet",
  parameters: {
    docs: {
      description: {
        component:
          "The keyboard reference (foundation P2), generated from registered actions and keymaps so it can't drift. `shortcutSheet({ groups })` is content only: the consumer collects the groups — the editor's `collectShortcuts(surface)` reads the surface's live, resolved key map — and wraps the sheet in a `popover()`. Rows pair an action's label with its registered key strings as `.nq-kbd` chips, verbatim; group titles are captions in graphite-muted. Use it for reference UI only: it shows what keys do and never executes anything, and it is never part of the input path.",
      },
    },
  },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const Static: Story = {
  render: () => sheetHost(GROUPS),
  play: async ({ canvas, globals, userEvent }) => {
    const theme = globals.theme === "dark" ? "dark" : "light";
    const trigger = canvas.getByRole("button", { name: "Keyboard shortcuts" });
    await userEvent.click(trigger);
    const sheet = await waitFor(() => {
      const element = document.body.querySelector<HTMLElement>(".nq-popover .nq-shortcuts")!;
      expect(element).toBeTruthy();
      return element;
    });
    // Grouped rows: three titled groups, each label with its keys as kbd chips, verbatim.
    await expect(within(sheet).getAllByRole("group").map(group => groupName(group as HTMLElement))).toEqual(["Text editing", "Block actions", "Tools"]);
    await expect(within(sheet).getByText("Bold")).toBeTruthy();
    await expect(within(sheet).getByText("Ctrl+B").classList.contains("nq-kbd")).toBe(true);
    await expect(within(sheet).getByText("Ctrl+Shift+Y")).toBeTruthy();
    const title = sheet.querySelector<HTMLElement>(".nq-shortcuts-title")!;
    await expect(title.classList.contains("nq-ui-caption")).toBe(true);
    await expect(getComputedStyle(title).color).toBe(rgb(resolveColor(tokens, "graphite-muted", theme)));
    // Esc dismisses, focus back on the trigger (the popover's contract).
    await userEvent.keyboard("{Escape}");
    await expect(document.body.querySelector(".nq-shortcuts")).toBeNull();
    await expect(trigger).toHaveFocus();
  },
};

export const EditorBacked: Story = {
  render: () => editorHost().page,
  play: async ({ canvasElement, userEvent }) => {
    const page = await waitFor(() => {
      const element = canvasElement.querySelector<HTMLElement>(".nq-editor")!;
      expect(element).toBeTruthy();
      return element;
    });
    const surface = surfaces.get(page)!;
    const host = await waitFor(() => {
      const rich = page.querySelector<HTMLElement>(".nq-rich-text")!;
      expect(rich.textContent).toBe("Maya writes in ink.");
      return rich;
    });

    // "?" inside the text host keeps typing: the character lands, no sheet.
    host.focus();
    await userEvent.keyboard("?");
    await expect(host.textContent).toContain("?");
    await expect(document.body.querySelector(".nq-shortcuts")).toBeNull();

    // "?" outside the input path (the surface root) opens the sheet with the real reference bindings.
    surface.element.focus();
    await userEvent.keyboard("?");
    const sheet = await waitFor(() => {
      const element = document.body.querySelector<HTMLElement>(".nq-popover .nq-shortcuts")!;
      expect(element).toBeTruthy();
      return element;
    });
    // Exactly what the live registry says: the rendered groups are the collected groups.
    await expect(within(sheet).getAllByRole("group").map(group => groupName(group as HTMLElement)))
      .toEqual(collectShortcuts(surface).map(group => group.title));
    // Straight from the registry: the reference bindings this surface dispatches through.
    await expect(within(sheet).getByText("Bold")).toBeTruthy();
    await expect(within(sheet).getByText("Split block")).toBeTruthy();
    await expect(within(sheet).getByText("Enter")).toBeTruthy();
    await expect(document.activeElement).toBe(sheet.closest(".nq-popover")); // reference UI may take focus

    // Esc closes returning focus to the surface (the popover's contract).
    await userEvent.keyboard("{Escape}");
    await expect(document.body.querySelector(".nq-shortcuts")).toBeNull();
    await expect(surface.element).toHaveFocus();
  },
};
