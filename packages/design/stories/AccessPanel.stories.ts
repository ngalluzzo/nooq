import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor, within } from "storybook/test";
import { createActorKey, createSecuredDocument, newBlockId, toBase64, type Access, type Transaction } from "@nooq/core";
import { commitSigned, newDocument } from "../../yjs/src/index.ts";
import { NooqRelay, settled } from "../../sync/src/index.ts";
import { Editor, createDocumentHeader, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { essentials, paragraph } from "../../plugins/src/essentials.ts";
import { accessPanel, type AccessPanelEntry } from "../src/index.ts";

/**
 * The access panel (foundation P1): who can edit this document, in which
 * role — the body of the header's access popover. Roles read from
 * replicated state (DM-12/13); display names join from awareness by actor
 * id, and a grant whose actor never arrived renders the bare actor id (the
 * honest limitation — no invented names). "Verified" is only ever "their
 * edits arrived verified here", the weak form the access investigation
 * found buildable; the footnote states the v1 limit: grants are append-only.
 */

const meta = {
  title: "Components/Access panel",
  parameters: {
    docs: {
      description: {
        component:
          "Who can edit, in which role, from the document's own access header: self first with the word `you`, then the owner, then every grant as an ActorChip with its role word in sentence case. A verified row carries the verified glyph titled \"Their edits arrived verified here\" — the transitive verdict, not a per-actor claim; an idle peer carries its word (§9). Compose it with `createDocumentHeader` from `@nooq/editor`, whose Access button appears only on secured documents and opens it in the popover; open documents have no access header and no button.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** Every panel state in one roster: owner, verified peer, idle peer, a grant that never arrived, a reader, an AI suggester. */
const ENTRIES: readonly AccessPanelEntry[] = [
  { actorId: "human:ren", name: "Ren", role: "writer", owner: true, ink: "magenta" },
  { actorId: "human:tomas", name: "Tomás", role: "writer", ink: "teal", verified: true },
  { actorId: "human:kai", name: "Kai", role: "writer", ink: "sepia", idle: true },
  { actorId: "human:3d91f2ab", role: "reader", ink: "green" },
  { actorId: "human:priya", name: "Priya", role: "reader", ink: "violet" },
  { actorId: "ai:reference", kind: "ai", model: "simulated/1", role: "suggester" },
];

export const Static: Story = {
  render: () => accessPanel({ self: { actorId: "human:maya", name: "Maya", role: "writer" }, entries: ENTRIES }),
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector<HTMLElement>(".nq-access")!;
    await expect(root).not.toBeNull();
    // Self first, with the word you; then the owner, then grants in order.
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".nq-access-row"));
    await expect(rows.map(row => row.getAttribute("data-nq-actor"))).toEqual([
      "human:maya", "human:ren", "human:tomas", "human:kai", "human:3d91f2ab", "human:priya", "ai:reference",
    ]);
    await expect(root.querySelector(".nq-access-self .nq-access-you")?.textContent).toBe("you");
    await expect(root.querySelector('.nq-access-row[data-nq-actor="human:ren"] .nq-access-role')?.textContent).toBe("Owner");
    // Verified is the weak verdict, stated exactly; idle carries its word (§9).
    await expect(root.querySelector(".nq-access-verified")?.getAttribute("title")).toBe("Their edits arrived verified here");
    await expect(root.querySelector(".nq-access-idle")?.textContent).toBe("idle");
    // The honest limitation: a grant that never arrived renders its bare actor id.
    await expect(root.querySelector('.nq-access-row[data-nq-actor="human:3d91f2ab"] .nq-actor-name')?.textContent).toBe("human:3d91f2ab");
    await expect(root.querySelector(".nq-access-note")?.textContent).toBe("Removing a writer takes effect per device at sync time (DM-13.6).");
  },
};

const editors = new Set<Editor>();
interface AccessStory { header: HTMLElement; surface: HTMLElement }
const fixtures = new WeakMap<HTMLElement, AccessStory>();

/** A secured document with a real second peer: genesis on the wire first, the peer writes, Maya opens the header. */
async function securedHost(): Promise<HTMLElement> {
  const mayaKey = await createActorKey(), tomasKey = await createActorKey(), aiKey = await createActorKey();
  const ownerParty = { actorId: "human:maya", key: toBase64(mayaKey.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const access: Access = {
    owner: ownerParty,
    nonce,
    grants: [
      { actorId: "human:tomas", key: toBase64(tomasKey.publicBytes), kind: "human", role: "writer" },
      { actorId: "human:3d91f2ab", key: toBase64((await createActorKey()).publicBytes), kind: "human", role: "reader" },
      { actorId: "ai:reference", key: toBase64(aiKey.publicBytes), kind: "ai", role: "suggester" },
    ],
  };
  const relay = new NooqRelay();
  // Genesis + grants ship once, before any editor connects — the peer writes
  // into a document whose access lineage is already on the wire, so the
  // hello/handshake race never sees a writer ahead of the access header.
  const ownerDoc = newDocument(docId);
  const genesis: Transaction = {
    id: newBlockId(),
    actor: { actorId: "human:maya", kind: "human" },
    lamport: 1,
    causality: {},
    ops: [{ op: "setAccess", access }],
  };
  const committed = await commitSigned(ownerDoc, genesis, mayaKey, "human:maya");
  const ship = relay.connect(docId);
  ship.send(JSON.stringify({ v: 1, t: "update", doc: docId, update: toBase64(committed.update), envelope: committed.envelope }));
  await settled(6);

  const maya = new Editor({ docId, actor: { actorId: "human:maya", name: "Maya" }, transport: relay.connect(docId), key: mayaKey, plugins: [essentials] });
  const tomas = new Editor({ docId, actor: { actorId: "human:tomas", name: "Tomás" }, transport: relay.connect(docId), key: tomasKey });
  editors.add(maya); editors.add(tomas);
  await settled();
  const block = tomas.insertBlock({ type: paragraph.type, parent: null, text: "The peer wrote this first." });
  await settled(6);
  tomas.setCursor({ block, offset: 4 }); // present, with a name on the awareness wire

  const header = createDocumentHeader(maya, { selfName: "Maya" });
  const surface = createSurface(maya, { plugins: [essentialsDOM] });
  const page = document.createElement("div");
  page.dataset.accessDemo = "true";
  page.style.cssText = "display:flex;flex-direction:column;gap:var(--nq-space-6);max-width:calc(var(--nq-measure) + var(--nq-gutter))"; // story-only framing; components never size themselves inline
  page.append(header.element, surface.element);
  fixtures.set(page, { header: header.element, surface: surface.element });
  return page;
}

export const EditorBacked: Story = {
  // The setup is async (keys, genesis, the wire); the container mounts now
  // and the page lands in it when the peer's document is real.
  render: () => {
    const container = document.createElement("div");
    void securedHost().then(page => container.append(page)).catch(error => console.error("access story setup failed", error));
    return container;
  },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  play: async ({ canvasElement, userEvent }) => {
    // The setup is async (keys, genesis, the wire): the page lands in the
    // canvas a beat after mount, and the play waits for the real thing.
    const demo = await waitFor(() => {
      const found = canvasElement.querySelector<HTMLElement>("[data-access-demo]");
      expect(found).not.toBeNull();
      return found!;
    }, { timeout: 15000 });
    const { header } = fixtures.get(demo)!;

    // The Access button mounts once the access header replicates here; open documents never show one.
    const button = await waitFor(() => {
      const found = header.querySelector<HTMLButtonElement>(".nq-header-side button");
      expect(found?.textContent).toBe("Access");
      return found!;
    }, { timeout: 5000 });

    // Click opens the popover anchored to the button, holding the live panel.
    await userEvent.click(button);
    const popover = await waitFor(() => {
      const open = document.body.querySelector<HTMLElement>(".nq-popover");
      expect(open?.querySelector(".nq-access")).not.toBeNull();
      return open!;
    });
    await expect(button.getAttribute("aria-expanded")).toBe("true");

    // The join, from a real editor: Maya (you, owner-as-writer), Tomás by his
    // awareness name and verified-here, the never-arrived grant bare.
    await waitFor(() => expect(popover.querySelector(".nq-access-self .nq-actor-name")?.textContent).toBe("Maya"), { timeout: 5000 });
    await expect(popover.querySelector(".nq-access-self .nq-access-you")?.textContent).toBe("you");
    await expect(popover.querySelector(".nq-access-self .nq-access-role")?.textContent).toBe("Writer");
    const tomasRow = await waitFor(() => {
      const row = popover.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:tomas"]');
      expect(row).not.toBeNull(); // his derived ink resolves a beat late; the row waits it out
      return row!;
    }, { timeout: 5000 });
    await expect(tomasRow.querySelector(".nq-actor-name")?.textContent).toBe("Tomás");
    await expect(tomasRow.querySelector(".nq-access-verified")?.getAttribute("title")).toBe("Their edits arrived verified here");
    const bareRow = await waitFor(() => {
      const row = popover.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:3d91f2ab"] .nq-actor-name');
      expect(row?.textContent).toBe("human:3d91f2ab"); // never arrived: the bare actor id, no invented name
      return row!;
    }, { timeout: 5000 });
    await expect(popover.querySelector('.nq-access-row[data-nq-actor="ai:reference"] .nq-access-role')?.textContent).toBe("Suggester");
    await expect(within(popover).queryByText("Removing a writer takes effect per device at sync time (DM-13.6).")).not.toBeNull();

    // Escape closes returning focus to the button (the popover's contract).
    await userEvent.keyboard("{Escape}");
    await expect(document.body.contains(popover)).toBe(false);
    await expect(button).toHaveFocus();
    await expect(button.getAttribute("aria-expanded")).toBe("false");
  },
};

/** The non-state: an open document has no access header, so the header shows no Access button at all. */
export const OpenDocument: Story = {
  render: () => {
    const editor = new Editor({ docId: `access-open-${crypto.randomUUID()}`, actor: { actorId: "human:solo", name: "Solo" }, plugins: [essentials] });
    editors.add(editor);
    const page = document.createElement("div");
    page.dataset.accessOpen = "true";
    const header = createDocumentHeader(editor, { selfName: "Solo" });
    page.append(header.element);
    fixtures.set(page, { header: header.element, surface: document.createElement("div") });
    return page;
  },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  play: async ({ canvasElement }) => {
    const demo = canvasElement.querySelector<HTMLElement>("[data-access-open]")!;
    const { header } = fixtures.get(demo)!;
    await expect(header.querySelector(".nq-header-side button")).toBeNull(); // no access header, no button
    await expect(header.querySelector(".nq-sync")?.textContent).toBe("Saved on this device"); // offline first (§2)
  },
};
