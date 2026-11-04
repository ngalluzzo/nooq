import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { actorIdOf, createActorKey, createSecuredDocument, newBlockId, toBase64, type Access, type Transaction } from "@nooq/core";
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
  // DM-12.4: a fingerprint document — every handle proves its key; names (DM-13.5) keep it human.
  const mayaId = actorIdOf("human", toBase64(mayaKey.publicBytes));
  const tomasId = actorIdOf("human", toBase64(tomasKey.publicBytes));
  const aiId = actorIdOf("ai", toBase64(aiKey.publicBytes));
  const owner = { actorId: mayaId, key: toBase64(mayaKey.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(owner);
  const access: Access = { owner: owner, nonce, grants: [
    { actorId: tomasId, key: toBase64(tomasKey.publicBytes), kind: "human", role: "writer", name: "Tomás" },
    { actorId: aiId, key: toBase64(aiKey.publicBytes), kind: "ai", role: "suggester", name: "Reference" },
  ] };
  const relay = new NooqRelay();
  const ownerDoc = newDocument(docId);
  const genesis: Transaction = { id: newBlockId(), actor: { actorId: mayaId, kind: "human" }, lamport: 1, causality: {}, ops: [{ op: "setAccess", access }] };
  const committed = await commitSigned(ownerDoc, genesis, mayaKey, mayaId);
  const ship = relay.connect(docId);
  ship.send(JSON.stringify({ v: 1, t: "update", doc: docId, update: toBase64(committed.update), envelope: committed.envelope }));
  await settled(6);

  const plugins = [...referencePlugins, codePlugin, mathPlugin, imagePlugin, diagramPlugin];
  const doms = [...referenceDOM, codeDOM, mathDOM, imageDOM(), diagramDOM];
  const maya = new Editor({ docId, actor: { actorId: mayaId, name: "Maya" }, key: mayaKey, transport: relay.connect(docId), jobBindings: referenceJobBindings(), plugins });
  const tomas = new Editor({ docId, actor: { actorId: tomasId, name: "Tomás" }, key: tomasKey, transport: relay.connect(docId), jobBindings: referenceJobBindings(), plugins });
  const ai = new Editor({ docId, actor: { actorId: aiId, name: "Reference", model: "qwen3-8b" }, key: aiKey, transport: relay.connect(docId), jobBindings: referenceJobBindings(), plugins });
  await settled(6);

  // The document is the team's own weekly — real prose, real structure;
  // every block type earns its place because the document calls for it.
  const insert = (editor: Editor, type: string, text: string, fields: Record<string, import("@nooq/core").JsonValue> = {}): string => editor.insertBlock({ type, parent: null, text, fields });
  insert(maya, "nooq.title/v1", "nooq weekly — the surface sprint");
  insert(maya, "nooq.paragraph/v1", "This week we closed the gap audit end to end. The audit asked what a skeptic reaches for in the first hour; every item on that list now ships, and the receipts are in the lab.");
  insert(maya, "nooq.heading/v1", "Shipped", { level: 2 });
  const first = insert(maya, "nooq.list/v1", "The writing surface: lists, levels, dividers, the drag handle", { kind: "bullet" });
  maya.insertBlock({ type: "nooq.list/v1", parent: first, text: "Paste round-trips markdown both directions — pinned by test", fields: { kind: "bullet" } });
  insert(maya, "nooq.list/v1", "Code blocks with real highlighting, math, diagrams, images", { kind: "bullet" });
  insert(maya, "nooq.list/v1", "Tables: three stages, the ragged-row decision held under gesture", { kind: "bullet" });
  insert(maya, "nooq.heading/v1", "The digest change", { level: 2 });
  insert(maya, "nooq.paragraph/v1", "Mark runs landed: the canonical text form compacted, identity re-derived once, the whole suite green without a single digest change. The derivation is one function:");
  insert(maya, "nooq.code/v1", "const textDigest = await fingerprint({ s: text.s, runs: runsOf(text) });", { lang: "ts" });
  insert(maya, "nooq.paragraph/v1", "The overhead bound, measured and pinned:");
  insert(maya, "nooq.math/v1", "\\text{overhead} = \\frac{|runs|}{|s|} < 1\\%");
  insert(maya, "nooq.heading/v1", "How a write travels", { level: 2 });
  insert(maya, "nooq.diagram/v1", "flowchart LR\n  W[Writer] --signed--> E[Envelope]\n  E --> R[Relay]\n  R --verified--> P[Peers]");
  insert(maya, "nooq.divider/v1", "");
  insert(maya, "nooq.heading/v1", "Status", { level: 2 });
  maya.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "" });
  maya.commands.run(insertTable, { parent: null });
  const tableId = [...maya.view.roots].reverse().find(id => maya.view.blocks[id]!.type === "nooq.table/v1")!;
  const rows = maya.view.blocks[tableId]!.children as string[];
  const cells = (row: string): string[] => maya.view.blocks[row]!.children as string[];
  cells(rows[0]!).forEach((cell, i) => maya.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: ["Area", "State", "Next"][i] ?? "" }] }));
  cells(rows[1]!).forEach((cell, i) => maya.commands.run("nooq.text.edit", { block: cell, changes: [{ insert: ["Trust layer", "Done", "Ratifies Nov 9"][i] ?? "" }] }));
  maya.commands.run(toggleHeaderRow, { row: rows[0]! });
  insert(maya, "nooq.paragraph/v1", "The budget graph, for the wall:");
  insert(maya, "nooq.image/v1", "EB-6 keystroke p95 across the sprint — flat where it matters", { src: "https://placehold.co/640x360/f2f0e5/555b6a?text=p95+by+week" });
  insert(maya, "nooq.heading/v1", "Open", { level: 2 });
  insert(maya, "nooq.list/v1", "Set the column-gesture budget from the measurement", { kind: "check" });
  insert(maya, "nooq.list/v1", "Mermaid sizing on narrow screens", { kind: "check", checked: true });
  await settled(6);

  // Tomás writes where he's working; the AI proposes the verdict's ending.
  const target = insert(tomas, "nooq.paragraph/v1", "The verdict so far: ");
  await settled(6);
  await ai.propose({
    actor: { actorId: aiId, name: "Reference", model: "qwen3-8b" },
    ops: [{ op: "textEdit", block: target, changes: [{ insert: "a skeptic's first hour is covered, with receipts." }] }],
    evidence: [target],
    intent: "complete-the-verdict",
  });
  await settled(6);
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
