import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor, within } from "storybook/test";
import { replaceChanges } from "@nooq/core";
import { essentials, paragraph } from "../../plugins/src/essentials.ts";
import { callout, calloutMarkdown, callouts } from "../../plugin-callouts/src/index.ts";
import { Editor } from "../../editor/src/index.ts";
import { createExportUI, type ExportUI } from "../../editor/src/export-ui.ts";
import { review } from "../../editor/src/reference.ts";
import { el } from "../src/dom.ts";

/**
 * The export dialog (foundation P2, composed from `createExportUI` in
 * `@nooq/editor`): the header's quiet Export button opens the design
 * `dialog()` over a snapshot of the document as it is that moment — export
 * is not access-gated, so open documents carry the button too. The dialog
 * names the one format ("Markdown", no fake choice) and states the pending
 * count exactly, and only when there is one. "Copy Markdown" is primary and
 * refuses gracefully — a refused clipboard never crashes, the dialog simply
 * closes; "Download" is quiet, feature-detected, and names the file for the
 * document. Escape or a press outside cancels (the dialog's contract). The
 * callout block travels through the composed `calloutMarkdown` formatter,
 * so it exports in GitHub-alert form.
 */

const editors = new Set<Editor>();
const uis = new Set<ExportUI>();

interface ExportStory {
  button: HTMLButtonElement;
  docId: string;
  copies: string[];
  downloads: Array<{ markdown: string; filename: string }>;
}
const fixtures = new WeakMap<HTMLElement, ExportStory>();

const meta = {
  title: "Components/Export dialog",
  parameters: {
    docs: {
      description: {
        component:
          "The export entry point, editor-composed: `createExportUI(editor, options)` mounts the quiet Export button (the access-glyph pattern) that opens the design dialog — title \"Export document\", the format line \"Markdown\", the exact pending line only when suggestions wait (\"2 pending suggestions are not included.\"), \"Download\" quiet and feature-detected (absent without downloads, never dead) and \"Copy Markdown\" primary with the digest component's graceful-refusal clipboard. The export is a snapshot of the moment the dialog opens; Escape and outside presses cancel. Compose it through `createDocumentHeader`'s `export` option; the reference composition (`referenceDocumentHeader`) turns it on with the callout formatter.",
      },
    },
  },
  beforeEach: () => {
    return () => {
      for (const ui of uis) ui.destroy(); // closes any open dialog, listeners and all
      uis.clear();
      for (const editor of editors) editor.close();
      editors.clear();
    };
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** The shared document: prose and a callout (through the composed formatter), plus `pending` awaiting suggestions. */
async function seed(editor: Editor, pending: number): Promise<void> {
  editor.insertBlock({ type: paragraph.type, parent: null, text: "Field notes from the pilot, six weeks in." });
  editor.insertBlock({ type: callout.type, parent: null, fields: { tone: "info" }, text: "Mind the gap between the platform and the train." });
  for (let i = 0; i < pending; i++) {
    const target = editor.insertBlock({ type: paragraph.type, parent: null, text: `Draft ${i + 1} awaiting review.` });
    await editor.propose({
      ops: [{ op: "textEdit", block: target, changes: replaceChanges(`Draft ${i + 1} awaiting review.`, `Draft ${i + 1}, tightened.`) }],
      evidence: [target],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
  }
}

/** A page whose Export button opens over the real document; `refuse` makes the clipboard refuse, the graceful path. */
function exportPage(pending: number, refuse: boolean): HTMLElement {
  const container = document.createElement("div");
  void (async () => {
    const editor = new Editor({ docId: `export-story-${crypto.randomUUID()}`, actor: { actorId: "human:maya", name: "Maya" }, plugins: [essentials, callouts, review] });
    editors.add(editor);
    await seed(editor, pending);
    const copies: string[] = [];
    const downloads: Array<{ markdown: string; filename: string }> = [];
    const ui = createExportUI(editor, {
      formatters: { [callout.type]: calloutMarkdown },
      copy: refuse ? () => Promise.reject(new Error("clipboard refused")) : (markdown) => { copies.push(markdown); },
      download: (markdown, filename) => { downloads.push({ markdown, filename }); },
    });
    uis.add(ui);
    const page = el(
      "div",
      { class: "sb-stack" },
      el("div", { class: "sb-row" }, ui.element),
      el("p", { class: "sb-prose nq-doc-body" }, "Field notes · the document beneath the dialog stays legible while the export decision is open."),
    );
    page.dataset.exportStory = "true";
    fixtures.set(page, { button: ui.element.querySelector("button")!, docId: editor.docId, copies, downloads });
    container.append(page);
  })().catch((error) => console.error("export story setup failed", error));
  return container;
}

/** The page under a play, once its real document has landed. */
async function storyPage(canvasElement: HTMLElement): Promise<ExportStory & { page: HTMLElement }> {
  const page = await waitFor(() => {
    const found = canvasElement.querySelector<HTMLElement>("[data-export-story]");
    expect(found).not.toBeNull();
    return found!;
  }, { timeout: 15000 });
  return { ...fixtures.get(page)!, page };
}

/** The open export dialog; dialogs are overlays, so they mount on the body, outside the canvas. */
async function open(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(element).toBeTruthy();
    return element!;
  });
}

export const ZeroPending: Story = {
  render: () => exportPage(0, false),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { button, copies } = await storyPage(canvasElement);

    // Keyboard-complete (§9): reach the button without a pointer and open with Enter.
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const dialog = await open();

    // One decision, labelled by its title; the one format, no fake choice; nothing pending.
    await expect(within(dialog).getByText("Export document")).toBeVisible();
    await expect(within(dialog).getByText("Markdown")).toBeVisible();
    await expect(within(dialog).queryByText(/pending suggestion/)).toBeNull();

    // Tab order inside the dialog: Download then Copy Markdown (primary last), wrapping both ways.
    const actions = within(dialog).getAllByRole("button");
    await expect(actions.map((a) => a.textContent)).toEqual(["Download", "Copy Markdown"]);
    await waitFor(() => expect(actions[0]).toHaveFocus());
    await userEvent.tab();
    await expect(actions[1]).toHaveFocus();
    await userEvent.tab();
    await expect(actions[0]).toHaveFocus(); // wrapped
    await userEvent.tab({ shift: true });
    await expect(actions[1]).toHaveFocus(); // wrapped back

    // Esc cancels — nothing was exported — and focus returns to the opener.
    await userEvent.keyboard("{Escape}");
    await expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await expect(button).toHaveFocus();
    expect(copies).toEqual([]);

    // Reopen and decide: Copy carries the real markdown, callout alert-formed, and the dialog closes itself.
    await userEvent.click(button);
    const again = await open();
    await userEvent.click(within(again).getByRole("button", { name: "Copy Markdown" }));
    await expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await expect(button).toHaveFocus();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain("Field notes from the pilot, six weeks in.");
    expect(copies[0]).toContain("> [!NOTE]"); // the callout, GitHub-alert-formed through the composed formatter (info → NOTE)
    expect(copies[0]).toContain("Mind the gap between the platform and the train.");
    await expect(canvas.getByText(/Field notes ·/)).toBeVisible();
  },
};

export const WithPending: Story = {
  render: () => exportPage(2, true),
  play: async ({ canvasElement, userEvent }) => {
    const { button, docId, copies, downloads } = await storyPage(canvasElement);

    // Two suggestions wait: the dialog states the exact count, pluralized.
    await userEvent.click(button);
    const dialog = await open();
    await expect(within(dialog).getByText("2 pending suggestions are not included.")).toBeVisible();

    // Download is quiet and names the file for the document; the dialog closes itself on the decision.
    await userEvent.click(within(dialog).getByRole("button", { name: "Download" }));
    await expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(downloads).toEqual([{ markdown: expect.stringContaining("Field notes from the pilot, six weeks in."), filename: `${docId}.md` }]);

    // The refused clipboard is the graceful path: the dialog simply closes, nothing crashes, nothing was copied.
    await userEvent.click(button);
    const again = await open();
    await userEvent.click(within(again).getByRole("button", { name: "Copy Markdown" }));
    await expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await expect(button).toHaveFocus();
    expect(copies).toEqual([]);
  },
};

/**
 * Mounted open, in the canvas where Storybook tears it down between stories:
 * the automatic axe check that follows every story sees the real structure —
 * the dialog role, aria-modal, the labelled title, the format and pending
 * lines, named actions — in both themes. The keyboard plays live on the
 * stories above.
 */
export const Open: Story = {
  render: () => {
    const editor = new Editor({ docId: `export-open-${crypto.randomUUID()}`, actor: { actorId: "human:maya", name: "Maya" }, plugins: [essentials, callouts, review] });
    editors.add(editor);
    editor.insertBlock({ type: paragraph.type, parent: null, text: "Field notes from the pilot, six weeks in." });
    const ui = createExportUI(editor, { formatters: { [callout.type]: calloutMarkdown } });
    uis.add(ui);
    const page = el(
      "div",
      { class: "sb-stack" },
      el("div", { class: "sb-row" }, ui.element),
      el("p", { class: "sb-prose nq-doc-body" }, "A host opens this from the header's Export button; the dialog carries every style itself."),
    );
    page.dataset.exportStory = "true";
    ui.element.querySelector<HTMLButtonElement>("button")!.click();
    // Into the canvas, where the automatic axe check looks (the export had mounted it on the body).
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog) page.append(dialog);
    return page;
  },
};
