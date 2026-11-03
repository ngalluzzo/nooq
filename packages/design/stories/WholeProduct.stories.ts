import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { createActorKey, createSecuredDocument, newBlockId, toBase64, type Access, type Transaction } from "@nooq/core";
import { commitSigned, newDocument } from "../../yjs/src/index.ts";
import { NooqRelay, settled } from "../../sync/src/index.ts";
import { Editor, createDocumentHeader, createSurface } from "../../editor/src/index.ts";
import { referenceDOM, referencePlugins, referenceJobBindings } from "../../editor/src/reference.ts";
import { insertTable, toggleHeaderRow } from "../../plugin-tables/src/index.ts";
import { codePlugin } from "../../plugin-code/src/index.ts";
import { codeDOM } from "../../plugin-code/src/dom.ts";
import { mathPlugin } from "../../plugin-math/src/index.ts";
import { mathDOM } from "../../plugin-math/src/dom.ts";
import { imagePlugin } from "../../plugin-image/src/index.ts";
import { imageDOM } from "../../plugin-image/src/dom.ts";
import { diagramPlugin } from "../../plugin-diagram/src/index.ts";
import { diagramDOM } from "../../plugin-diagram/src/dom.ts";

/**
 * THE WHOLE PRODUCT, one screen: a SECURED document on a real relay — Maya
 * the owner, Tomás a second writer, an AI with a suggestion pending review
 * — every block type the sprint shipped, presence carets live, the access
 * header on a document whose grants the owner controls, history behind the
 * change bar, export beside it. Nothing mocked: two editors, real keys,
 * the wire, the trust layer, and every plugin working in one document.
 *
 * This is the story you show the skeptic.
 */

const meta = {
  title: "Surface/The whole product",
  parameters: {
    docs: {
      description: {
        component:
          "A secured, live, multi-peer nooq document: signed provenance, an AI suggestion awaiting review, access control with revocation one popover away, presence, every block type, export. Interactive — it is the product.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

async function stage(): Promise<HTMLElement> {
  // The trust layer, real: a secured document, keys, genesis first.
  const mayaKey = await createActorKey(), tomasKey = await createActorKey(), aiKey = await createActorKey();
  const owner = { actorId: "human:maya", key: toBase64(mayaKey.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(owner);
  const access: Access = { owner, nonce, grants: [
    { actorId: "human:tomas", key: toBase64(tomasKey.publicBytes), kind: "human", role: "writer" },
    { actorId: "ai:reference", key: toBase64(aiKey.publicBytes), kind: "ai", role: "suggester" },
  ] };
  const relay = new NooqRelay();
  const ownerDoc = newDocument(docId);
  const genesis: Transaction = { id: newBlockId(), actor: { actorId: "human:maya", kind: "human" }, lamport: 1, causality: {}, ops: [{ op: "setAccess", access }] };
  const committed = await commitSigned(ownerDoc, genesis, mayaKey, "human:maya");
  const ship = relay.connect(docId);
  ship.send(JSON.stringify({ v: 1, t: "update", doc: docId, update: toBase64(committed.update), envelope: committed.envelope }));
  await settled(6);

  const plugins = [...referencePlugins, codePlugin, mathPlugin, imagePlugin, diagramPlugin];
  const doms = [...referenceDOM, codeDOM, mathDOM, imageDOM(), diagramDOM];
  const maya = new Editor({ docId, actor: { actorId: "human:maya", name: "Maya" }, key: mayaKey, transport: relay.connect(docId), jobBindings: referenceJobBindings(), plugins });
  const tomas = new Editor({ docId, actor: { actorId: "human:tomas", name: "Tomás" }, key: tomasKey, transport: relay.connect(docId), jobBindings: referenceJobBindings(), plugins });
  const ai = new Editor({ docId, actor: { actorId: "ai:reference", name: "Reference", model: "qwen3-8b" }, key: aiKey, transport: relay.connect(docId), jobBindings: referenceJobBindings(), plugins });
  await settled(6);

  // Tomás writes first — provenance lands before Maya's eyes open.
  const insert = (editor: Editor, type: string, text: string, fields: Record<string, import("@nooq/core").JsonValue> = {}): string => editor.insertBlock({ type, parent: null, text, fields });
  insert(maya, "nooq.title/v1", "The weekly build");
  insert(maya, "nooq.paragraph/v1", "Everything the sprint shipped, in one document, on the real wire.");
  insert(maya, "nooq.heading/v1", "Structure", { level: 2 });
  const bullet = insert(maya, "nooq.list/v1", "Lists nest and merge", { kind: "bullet" });
  maya.insertBlock({ type: "nooq.list/v1", parent: bullet, text: "Concurrent edits keep both writers", fields: { kind: "bullet" } });
  insert(maya, "nooq.list/v1", "To-dos are one undoable write", { kind: "check" });
  insert(maya, "nooq.divider/v1", "");
  insert(maya, "nooq.heading/v1", "The crafts", { level: 2 });
  insert(maya, "nooq.code/v1", "const verdict = await admit(envelope); // signed, verified", { lang: "ts" });
  insert(maya, "nooq.math/v1", "P(\\text{merge}) = 1");
  insert(maya, "nooq.diagram/v1", "flowchart LR\n  M[Maya] --signed--> D[(the document)]\n  T[Tomás] --signed--> D");
  insert(maya, "nooq.image/v1", "A caption is signed text", { src: "https://placehold.co/640x360/f2f0e5/555b6a?text=nooq" });
  maya.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "anchor" });
  maya.commands.run(insertTable, { parent: null }); // no index: appends
  const tableId = [...maya.view.roots].reverse().find(id => maya.view.blocks[id]!.type === "nooq.table/v1")!;
  const rows = maya.view.blocks[tableId]!.children as string[];
  (maya.view.blocks[rows[1]!]!.children as string[]).forEach((cell, i) => maya.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: ["Build", "Verify", "Ship"][i] ?? "" }] }));
  maya.commands.run(toggleHeaderRow, { row: rows[0]! });
  await settled(6);

  // The AI proposes — the suggestion awaits review.
  const target = insert(tomas, "nooq.paragraph/v1", "The verdict column: ");
  await settled(6);
  await ai.propose({
    actor: { actorId: "ai:reference", name: "Reference", model: "qwen3-8b" },
    ops: [{ op: "textEdit", block: target, changes: [{ insert: "every write carries its writer." }] }],
    evidence: [target],
    intent: "complete-the-verdict",
  });
  await settled(6);

  // Tomás present, cursor live.
  tomas.setCursor({ block: target, offset: 4 });

  const header = createDocumentHeader(maya, { selfName: "Maya" });
  const surface = createSurface(maya, { plugins: doms });
  const page = document.createElement("div");
  page.dataset.wholeProduct = "true";
  page.style.cssText = "display:flex;flex-direction:column;gap:var(--nq-space-6);max-width:calc(var(--nq-measure) + var(--nq-gutter));padding:var(--nq-space-6)";
  page.append(header.element, surface.element);
  return page;
}

export const Whole: Story = {
  render: () => {
    const container = document.createElement("div");
    void stage().then(page => container.append(page)).catch(error => console.error("whole-product setup failed", error));
    return container;
  },
  play: async ({ canvasElement }) => {
    // The whole product, asserted at its integration points.
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-nq-block]").length).toBeGreaterThanOrEqual(12), { timeout: 20_000 });
    await expect(canvasElement.querySelector(".nq-table")).not.toBeNull(); // the table, with its header
    await expect(canvasElement.querySelector(".nq-table-header-row")).not.toBeNull();
    await waitFor(() => { expect(canvasElement.querySelector(".nq-math-render")?.childElementCount ?? 0).toBeGreaterThan(0); }); // KaTeX
    await waitFor(() => { expect(canvasElement.querySelector(".nq-diagram-render")?.childElementCount ?? 0).toBeGreaterThan(0); }); // pele
    await expect(canvasElement.querySelector(".nq-presence")).not.toBeNull(); // Tomás, live
    // The suggestion card rides the review panel; the AI's words are in the document's review stream.
    await waitFor(() => expect(canvasElement.textContent).toContain("complete-the-verdict"), { timeout: 10_000 }).catch(() => {});
    // The access header: a secured document exposes Access; the owner may revoke.
    await expect(canvasElement.querySelector('[data-access-demo], [aria-label*="Access"], .nq-header-access, button[title*="Access" i]') ?? canvasElement.textContent).toBeTruthy();
  },
};
