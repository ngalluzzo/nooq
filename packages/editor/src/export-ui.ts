/**
 * The export entry point (foundation P2, on the export engine): a quiet
 * Export button for the document header's actions slot — open documents get
 * it too, because export is not access-gated — opening the design dialog
 * over a snapshot of the document as it is the moment the dialog opens
 * (never a live view; later edits are not in an export already on screen).
 *
 * The dialog names the one format — "Markdown", no fake choice — and states
 * the pending count exactly, and only when there is one ("2 pending
 * suggestions are not included."). "Copy Markdown" is primary and uses the
 * digest component's graceful-refusal clipboard: on refusal nothing crashes
 * and the dialog simply closes. "Download" is quiet, a Blob of
 * text/markdown named for the document (`docId + ".md"`), and
 * feature-detected — an environment without downloads shows no Download
 * action, never a dead one. Escape or a press outside cancels (the dialog's
 * contract); activating an action runs it and closes silently.
 */
import { button, dialog, glyph, type DialogAction, type DialogHandle } from "@nooq/design";
import { exportMarkdown, type DocState } from "@nooq/plugins";

/**
 * What this module reads from the editor: the document's id (the download
 * filename) and its current state (the engine's input). Accepts the Editor
 * itself; the narrow source keeps hosts and tests honest about what it reads.
 */
export interface ExportSource {
  readonly docId: string;
  readonly view: DocState;
}

/** The engine's own options (`exportMarkdown`'s second argument), passed through verbatim; the reference composes block formatters — `calloutMarkdown` — here. */
export type ExportOptions = NonNullable<Parameters<typeof exportMarkdown>[1]>;

export interface ExportSinks {
  /**
   * Defaults to the async clipboard; a rejection or a synchronous throw is
   * ignored (the digest pattern) — on refusal nothing crashes, the dialog
   * simply closes. Injectable so the copy path is testable.
   */
  copy?: (markdown: string) => Promise<void> | void;
  /**
   * Defaults to a Blob download of text/markdown. Providing it also offers
   * the Download action in environments the feature detection would refuse
   * (the host vouches for the sink); injectable so the path is testable.
   */
  download?: (markdown: string, filename: string) => void;
}

/** Everything `createExportUI` takes: the engine's options plus the injectable sinks. */
export type ExportUIOptions = ExportOptions & ExportSinks;

export interface ExportUI {
  /** Mounts into the header's actions slot: the Export button, always — export is not access-gated. */
  element: HTMLElement;
  destroy(): void;
}

/** The digest component's clipboard: the async write, absent without one, never a throw. */
function clipboardCopy(markdown: string): Promise<void> | void {
  return navigator.clipboard?.writeText(markdown);
}

/** A Blob of text/markdown through an anchor the writer never sees. */
function anchorDownload(markdown: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // One task later, so the click has picked the URL up.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Downloads are feature-detected: a Blob, an object URL, and an anchor that accepts `download`. */
function downloadsSupported(): boolean {
  return typeof Blob === "function" && typeof URL.createObjectURL === "function" && "download" in document.createElement("a");
}

/** The pending line states the exact count, pluralized; zero pending renders nothing at all. */
function pendingLine(pending: number): string {
  const one = pending === 1;
  return `${pending} pending suggestion${one ? "" : "s"} ${one ? "is" : "are"} not included.`;
}

export function createExportUI(editor: ExportSource, options: ExportUIOptions = {}): ExportUI {
  const { copy = clipboardCopy, download = anchorDownload, ...engine } = options;
  const element = document.createElement("span");
  element.className = "nq-export-slot";
  let handle: DialogHandle | undefined;
  let destroyed = false;

  function open(): void {
    if (destroyed) return;
    // An action closed the last dialog silently (a decision, not a cancel);
    // a stale handle must not block the next export.
    if (handle) {
      if (handle.element.isConnected) return;
      handle = undefined;
    }
    // The export runs when the dialog opens — a snapshot of now.
    const snapshot = exportMarkdown(editor.view, engine);
    const body = document.createElement("div");
    const format = document.createElement("p");
    format.textContent = "Markdown"; // the one format; no fake choice
    body.append(format);
    if (snapshot.pending > 0) {
      const pending = document.createElement("p");
      pending.textContent = pendingLine(snapshot.pending);
      body.append(pending);
    }
    const actions: DialogAction[] = [];
    if (options.download !== undefined || downloadsSupported()) {
      actions.push({ label: "Download", variant: "quiet", onClick: () => download(snapshot.markdown, `${editor.docId}.md`) });
    }
    actions.push({
      label: "Copy Markdown",
      variant: "primary",
      onClick: () => {
        try {
          Promise.resolve(copy(snapshot.markdown)).catch(() => {});
        } catch {
          // Clipboard refused; the dialog simply closes.
        }
      },
    });
    handle = dialog({ title: "Export document", body, actions });
    document.body.append(handle.element);
  }

  const exportButton = button({ label: [glyph("export"), "Export"], variant: "quiet", onClick: open });
  exportButton.setAttribute("aria-haspopup", "dialog");
  element.append(exportButton);

  return {
    element,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      handle?.destroy(); // silent: programmatic teardown reports nothing; focus still returns
      handle = undefined;
      element.remove();
    },
  };
}
