/**
 * The lab page: mounts the reference editor on a reference document and
 * reports what the harness needs. It only observes; it never helps the
 * editor (no focusing on its behalf, no marks it should emit itself).
 */

import * as Y from "yjs";
import { newBlockId, type BlockId, type Op } from "@nooq/core";
import { Editor } from "../../src/controller.ts";
import { createSurface } from "../../src/dom.ts";

const params = new URLSearchParams(location.search);
const docName = params.get("doc") ?? "ref-small";
const DOC_ID = `lab-${docName}`;

const editor = new Editor({ docId: DOC_ID, actor: { actorId: "human:lab", name: "Lab writer" } });
const update = new Uint8Array(await (await fetch(`/doc/${docName}?id=${DOC_ID}`)).arrayBuffer());
Y.applyUpdate(editor.ydoc, update);
const surface = createSurface(editor);
document.getElementById("root")!.append(surface.element);

/**
 * Harness-observed marks, standing in until the editor emits nq:visible and
 * nq:editable itself (EB-5). "Visible": the first frame with block rows.
 * "Editable": the first frame where focus is inside the editor, with no help.
 */
let frames = 0;
function observe(): void {
  frames++;
  const rows = surface.element.querySelectorAll("[data-nq-block]").length;
  if (rows > 0 && performance.getEntriesByName("lab:visible").length === 0) performance.mark("lab:visible");
  if (surface.element.contains(document.activeElement) && performance.getEntriesByName("lab:editable").length === 0) {
    performance.mark("lab:editable");
    return;
  }
  if (frames < 240) requestAnimationFrame(observe);
}
requestAnimationFrame(observe);

const remoteActor = { actorId: "human:remote", kind: "human" as const };
let remoteLamport = 0;

/** Times focus left the editor without the writer moving it (a re-render that dropped the caret, say). */
let focusLosses = 0;
document.addEventListener(
  "focusout",
  () => setTimeout(() => {
    if (!surface.element.contains(document.activeElement)) focusLosses++;
  }, 0),
  true,
);

/** Helpers the harness calls through view.evaluate(). */
const lab = {
  docName,
  blockCount: () => surface.element.querySelectorAll("[data-nq-block]").length,
  marks: () =>
    Object.fromEntries(
      ["lab:visible", "lab:editable", "nq:visible", "nq:editable", "first-contentful-paint", "first-paint"].map((name) => [
        name,
        performance.getEntriesByName(name)[0]?.startTime ?? null,
      ]),
    ),
  textOf: (block: BlockId) => editor.view.blocks[block]?.text?.s ?? null,
  totalChars: () => Array.from(surface.element.querySelectorAll("textarea")).reduce((n, t) => n + t.value.length, 0),
  focusLosses: () => focusLosses,
  /** The block at the top of the viewport: what scroll anchoring keeps in place (EB-7). */
  topVisibleBlock: () => {
    for (const row of Array.from(surface.element.querySelectorAll("[data-nq-block]"))) {
      if (row.getBoundingClientRect().bottom > 0) return row.getAttribute("data-nq-block");
    }
    return null;
  },
  blockIds: () => Array.from(surface.element.querySelectorAll("[data-nq-block]")).map((row) => row.getAttribute("data-nq-block")!),
  /** Where focus and selection are, and where a given block sits on screen. */
  probe: (anchor: BlockId) => {
    const active = document.activeElement as HTMLTextAreaElement | null;
    const row = surface.element.querySelector(`[data-nq-block="${anchor}"]`);
    return {
      focusedBlock: active?.closest("[data-nq-block]")?.getAttribute("data-nq-block") ?? null,
      selection: active && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null,
      anchorTop: row ? row.getBoundingClientRect().top : null,
      scrollY: window.scrollY,
    };
  },
  /** A remote writer's transaction, as if it had just merged in (EB-7). */
  remote: (op: Op) => {
    editor.apply({ id: newBlockId(), actor: remoteActor, lamport: ++remoteLamport + 1_000_000, causality: {}, intent: "lab-remote", ops: [op] });
  },
  /** Resolves after the editor has rendered and two frames have painted. */
  settle: () => new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 0)),
};

(window as unknown as { lab: typeof lab }).lab = lab;
document.documentElement.dataset.labReady = "true";
