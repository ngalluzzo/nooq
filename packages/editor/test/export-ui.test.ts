/**
 * The export entry point (foundation P2, on the export engine): the header's
 * quiet Export button — open documents get it too, export is not
 * access-gated — opening the design dialog over a snapshot of the document
 * as it was when the dialog opened. The format line names the one format;
 * pending suggestions are counted exactly and only named when there are any;
 * Copy Markdown is the primary, graceful-refusal clipboard; Download is
 * feature-detected and named for the document.
 */
import "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { replaceChanges } from "@nooq/core";
import { exportMarkdown } from "@nooq/plugins";
import { essentials, paragraph } from "@nooq/plugins/essentials";
import { callout, calloutMarkdown, callouts } from "@nooq/plugin-callouts";
import { Editor } from "../src/controller.ts";
import { createExportUI, type ExportUI } from "../src/export-ui.ts";
import { createDocumentHeader } from "../src/header.ts";
import { referenceDocumentHeader, review } from "../src/reference.ts";

/** The reference composition's formatter map, what every dialog under test exports through. */
const formatters = { [callout.type]: calloutMarkdown };

/** A real open document carrying the blocks the export must render: prose, a callout, and (optionally) pending suggestions. */
async function exportEditor(pendingSuggestions = 0): Promise<Editor> {
  const editor = new Editor({
    docId: `export-${crypto.randomUUID()}`,
    actor: { actorId: "human:writer", name: "Writer" },
    plugins: [essentials, callouts, review],
  });
  editors.add(editor);
  editor.insertBlock({ type: paragraph.type, parent: null, text: "Plain paragraph for export." });
  editor.insertBlock({ type: callout.type, parent: null, fields: { tone: "info" }, text: "Mind the gap." });
  for (let i = 0; i < pendingSuggestions; i++) {
    const target = editor.insertBlock({ type: paragraph.type, parent: null, text: `Paragraph ${i + 1} awaiting review.` });
    await editor.propose({
      ops: [{ op: "textEdit", block: target, changes: replaceChanges(`Paragraph ${i + 1} awaiting review.`, `Paragraph ${i + 1} improved.`) }],
      evidence: [target],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
  }
  return editor;
}

const editors = new Set<Editor>();
afterEach(() => {
  for (const editor of editors) editor.close();
  editors.clear();
  document.body.innerHTML = "";
});

/** The Export button, focused the way a keyboard writer reaches it, and the dialog it opened. */
async function opened(ui: ExportUI): Promise<{ button: HTMLButtonElement; dialog: HTMLElement }> {
  const button = ui.element.querySelector<HTMLButtonElement>("button")!;
  button.focus();
  button.click();
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("the export dialog did not open");
  await null; // the dialog's focus move-in lands on the next microtask
  return { button, dialog };
}

/** A dialog action by its exact label — an action is a verb. */
function action(dialog: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === label);
  if (!found) throw new Error(`no ${label} action`);
  return found;
}

describe("the export entry point", () => {
  test("the button mounts on an open document — export is not access-gated", async () => {
    const editor = await exportEditor();
    expect(editor.accessState()).toBeUndefined(); // an open document, no access header

    const ui = createExportUI(editor);
    document.body.append(ui.element);
    const button = ui.element.querySelector<HTMLButtonElement>("button")!;
    expect(button.textContent).toBe("Export"); // the glyph is aria-hidden; the word is the name
    expect(button.classList.contains("nq-btn-quiet")).toBe(true);
    expect(button.querySelector("svg[data-glyph='export']")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    ui.destroy();

    // Through the header: off unless configured, on for every document when it is.
    const plain = createDocumentHeader(editor);
    document.body.append(plain.element);
    expect(plain.element.querySelector(".nq-header-side button")).toBeNull(); // no Access (open doc), no unasked-for Export
    plain.destroy();

    const configured = createDocumentHeader(editor, { export: {} });
    document.body.append(configured.element);
    expect(configured.element.querySelector(".nq-header-side button")?.textContent).toBe("Export");
    configured.destroy();

    const reference = referenceDocumentHeader(editor);
    document.body.append(reference.element);
    expect(reference.element.querySelector(".nq-header-side button")?.textContent).toBe("Export"); // the reference composition turns it on
    reference.destroy();
  });

  test("the dialog reflects a real document's export: the markdown through the composed callout formatter, and the pending count exact", async () => {
    const editor = await exportEditor(1);
    const copies: string[] = [];
    const ui = createExportUI(editor, { formatters, copy: (markdown) => { copies.push(markdown); } });
    document.body.append(ui.element);
    const { dialog } = await opened(ui);

    // The engine's own verdict for the same state through the same composed formatter.
    const expected = exportMarkdown(editor.view, { formatters });
    expect(expected.pending).toBe(1); // one proposal, not yet adopted or rejected
    expect(dialog.textContent).toContain("Markdown"); // the one format line — no fake choice
    expect(dialog.textContent).toContain("1 pending suggestion is not included."); // exact, singular

    // Copy carries the real markdown: the prose as written, and the callout in GitHub-alert form.
    action(dialog, "Copy Markdown").click();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toBe(expected.markdown);
    expect(copies[0]).toContain("Plain paragraph for export.");
    expect(copies[0]).toContain("Mind the gap.");
    expect(copies[0]).toContain("> [!NOTE]"); // the callout, alert-formed through the composed formatter (info → NOTE)
    expect(copies[0]).toMatch(/^> \[!NOTE\]$/m);
    expect(dialog.isConnected).toBe(false); // an action is a decision: it closed itself, silently
    ui.destroy();
  });

  test("zero pending renders no pending line; two pending state the exact plural count", async () => {
    const zero = await exportEditor(0);
    const zeroUi = createExportUI(zero, { formatters });
    document.body.append(zeroUi.element);
    const { dialog: quiet } = await opened(zeroUi);
    expect(quiet.textContent).not.toMatch(/pending suggestion/);
    action(quiet, "Copy Markdown").click(); // close through the dialog itself, never a raw remove
    zeroUi.destroy();

    const two = await exportEditor(2);
    const twoUi = createExportUI(two, { formatters });
    document.body.append(twoUi.element);
    const { dialog: busy } = await opened(twoUi);
    expect(exportMarkdown(two.view, { formatters }).pending).toBe(2);
    expect(busy.textContent).toContain("2 pending suggestions are not included."); // exact, plural
    twoUi.destroy();
  });

  test("the export is a snapshot of the moment the dialog opened, not a live view", async () => {
    const editor = await exportEditor(0);
    const copies: string[] = [];
    const ui = createExportUI(editor, { formatters, copy: (markdown) => { copies.push(markdown); } });
    document.body.append(ui.element);
    const { dialog } = await opened(ui);
    editor.insertBlock({ type: paragraph.type, parent: null, text: "Typed after the dialog opened." });
    action(dialog, "Copy Markdown").click();
    expect(copies[0]).not.toContain("Typed after the dialog opened.");
    ui.destroy();
  });

  test("Escape cancels — the dialog contract — and focus returns to the Export button", async () => {
    const editor = await exportEditor(0);
    const ui = createExportUI(editor, { formatters });
    document.body.append(ui.element);
    const { button, dialog } = await opened(ui);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement).toBe(button);
    ui.destroy();
  });

  test("Download exports a text/markdown Blob named for the document; without downloads the action is absent, never dead", async () => {
    const editor = await exportEditor(0);
    const expected = exportMarkdown(editor.view, { formatters }).markdown;

    // The real path: an object URL and an anchor download (happy-dom supports both).
    const created: string[] = [];
    const original = URL.createObjectURL;
    const real = createExportUI(editor, { formatters });
    document.body.append(real.element);
    try {
      (URL as { createObjectURL: (blob: Blob) => string }).createObjectURL = (blob: Blob): string => {
        created.push(blob.type);
        return original.call(URL, blob);
      };
      const { dialog } = await opened(real);
      expect(Array.from(dialog.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Download", "Copy Markdown"]); // primary last
      action(dialog, "Download").click();
    } finally {
      (URL as { createObjectURL: unknown }).createObjectURL = original;
    }
    expect(created).toEqual(["text/markdown"]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull(); // the action closed the dialog itself
    real.destroy();

    // Feature-detected absence: no object URLs, no Download action — Copy Markdown still there.
    const bare = createExportUI(editor, { formatters });
    document.body.append(bare.element);
    try {
      (URL as { createObjectURL: unknown }).createObjectURL = undefined;
      const { dialog } = await opened(bare);
      expect(Array.from(dialog.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Copy Markdown"]);
    } finally {
      (URL as { createObjectURL: unknown }).createObjectURL = original;
    }
    bare.destroy();

    // The injected sink: the host vouches for downloads, so the action returns, named docId + ".md".
    const downloads: Array<{ markdown: string; filename: string }> = [];
    const hosted = createExportUI(editor, { formatters, download: (markdown, filename) => { downloads.push({ markdown, filename }); } });
    document.body.append(hosted.element);
    const { dialog: sink } = await opened(hosted);
    action(sink, "Download").click();
    expect(downloads).toEqual([{ markdown: expected, filename: `${editor.docId}.md` }]);
    hosted.destroy();
  });

  test("a refused clipboard never crashes — the dialog simply closes", async () => {
    const editor = await exportEditor(0);
    const throwing = createExportUI(editor, { formatters, copy: () => { throw new Error("no clipboard"); } });
    document.body.append(throwing.element);
    const { dialog: sync } = await opened(throwing);
    expect(() => action(sync, "Copy Markdown").click()).not.toThrow();
    expect(sync.isConnected).toBe(false);
    throwing.destroy();

    const rejecting = createExportUI(editor, { formatters, copy: () => Promise.reject(new Error("clipboard refused")) });
    document.body.append(rejecting.element);
    const { dialog: async } = await opened(rejecting);
    expect(() => action(async, "Copy Markdown").click()).not.toThrow(); // the rejection is caught, never unhandled
    expect(async.isConnected).toBe(false);
    rejecting.destroy();
  });

  test("destroy cleans up: the open dialog goes with the button, and destroy is idempotent", async () => {
    const editor = await exportEditor(0);
    const ui = createExportUI(editor, { formatters });
    document.body.append(ui.element);
    const { dialog } = await opened(ui);
    ui.destroy();
    expect(dialog.isConnected).toBe(false);
    expect(ui.element.isConnected).toBe(false);
    ui.destroy(); // idempotent

    // And through the header: destroying the header tears down its export dialog too.
    const header = createDocumentHeader(editor, { export: { formatters } });
    document.body.append(header.element);
    header.element.querySelector<HTMLButtonElement>("button")!.click();
    const open = document.body.querySelector('[role="dialog"]');
    expect(open).not.toBeNull();
    header.destroy();
    expect(open!.isConnected).toBe(false);
  });
});
