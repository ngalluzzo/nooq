import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor, within } from "storybook/test";
import { createActorKey, createSecuredDocument, newBlockId, toBase64, type Access, type Role, type Transaction } from "@nooq/core";
import { commitSigned, newDocument, readState } from "../../yjs/src/index.ts";
import { NooqRelay, settled, SyncSession } from "../../sync/src/index.ts";
import { accessPanel, historyEvent, type AccessPanelEntry } from "../src/index.ts";

/**
 * Revocation (DM-13.6, proposals/0012): the owner rotates, the removed
 * writer's badge appears, and the history gets one plain sentence. The
 * product answers are codified here as the visible surface: eventual is
 * stated ("takes effect per device at sync time"), the ACTOR is labeled
 * ("removed" badge, no role word) — never the mechanics (no epochs, rolls,
 * or verdicts in human-facing words) — and the history event line is one
 * honest sentence. The wire vocabulary lives in provenance panes and specs.
 */

const meta = {
  title: "Components/Revocation",
  parameters: {
    docs: {
      description: {
        component:
          "What firing a writer looks like under grant epochs: the access panel's removed row (badge, no role word), the footnote stating the honest timing, and the history's single event line. Built from a live rotation through a real relay — the same machinery as the sync tests, rendered.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

let lamport = 0;
const tx = (ops: never[], actorId = "human:maya"): Transaction => ({ id: newBlockId(), actor: { actorId, kind: "human" }, lamport: ++lamport, causality: {}, ops });

/** Static panel state: pre-rotation roster vs post-rotation roster. */
const BEFORE: readonly AccessPanelEntry[] = [
  { actorId: "human:maya", name: "Maya", role: "writer", owner: true, ink: "magenta" },
  { actorId: "human:tomas", name: "Tomás", role: "writer", ink: "teal" },
  { actorId: "human:priya", name: "Priya", role: "reader", ink: "violet" },
];
const AFTER: readonly AccessPanelEntry[] = [
  { actorId: "human:maya", name: "Maya", role: "writer", owner: true, ink: "magenta" },
  { actorId: "human:tomas", name: "Tomás", removed: true, role: "writer", ink: "teal" },
  { actorId: "human:priya", name: "Priya", role: "reader", ink: "violet" },
];

export const Static: Story = {
  render: () => {
    const wrap = document.createElement("div");
    wrap.style.display = "grid";
    wrap.style.gap = "1rem";
    wrap.append(
      accessPanel({ self: { actorId: "human:maya", name: "Maya", role: "writer" }, entries: BEFORE }),
      accessPanel({ self: { actorId: "human:maya", name: "Maya", role: "writer" }, entries: AFTER }),
      (() => { const ul = document.createElement("ul"); ul.className = "nq-history"; ul.append(historyEvent("Tomás was removed from this document.")); return ul; })(),
    );
    return wrap;
  },
  play: async ({ canvasElement }) => {
    const panels = canvasElement.querySelectorAll<HTMLElement>(".nq-access");
    await expect(panels.length).toBe(2);
    // Before: Tomás writes.
    const tomasBefore = panels[0]!.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:tomas"]')!;
    await expect(tomasBefore.querySelector(".nq-access-role")?.textContent).toBe("Writer");
    // After: the badge says removed; the role word is gone — they have none.
    const tomasAfter = panels[1]!.querySelector<HTMLElement>('.nq-access-row[data-nq-actor="human:tomas"]')!;
    await expect(tomasAfter.querySelector(".nq-access-removed")?.textContent).toBe("removed");
    await expect(tomasAfter.querySelector(".nq-access-role")?.textContent).toBe("");
    // The footnote states the timing honestly, in product words.
    await expect(panels[1]!.querySelector(".nq-access-note")?.textContent).toBe("Removing a writer takes effect per device at sync time (DM-13.6).");
    // History: one plain sentence.
    await expect(canvasElement.querySelector(".nq-history-event")?.textContent).toBe("Tomás was removed from this document.");
  },
};

/** The live one: a real rotation through a real relay, rendered as it lands. */
export const LiveRotation: Story = {
  render: () => {
    const wrap = document.createElement("div");
    wrap.style.display = "grid";
    wrap.style.gap = "1rem";
    const mount = document.createElement("div");
    const history = document.createElement("ul");
    history.className = "nq-history";
    wrap.append(mount, history);
    void buildLive(mount, history);
    return wrap;
  },
  play: async ({ canvasElement }) => {
    // The rotation lands within the story's own timeline: badge + sentence.
    await waitFor(() => expect(canvasElement.querySelector(".nq-access-removed")?.textContent).toBe("removed"), { timeout: 15_000 });
    await waitFor(() => expect(canvasElement.querySelector(".nq-history-event")?.textContent).toBe("Tomás was removed from this document."), { timeout: 5_000 });
  },
};

/** The rotation dialog: the re-signing bill before the epoch advances. */
export const RotationDialog: Story = {
  render: () => {
    const wrap = document.createElement("div");
    wrap.style.display = "grid";
    wrap.style.gap = "1rem";
    void buildLive(wrap, document.createElement("ul"), { withDialog: true });
    return wrap;
  },
  play: async ({ canvasElement }) => {
    // The dialog opens with the bill; the words are the product answers.
    await waitFor(() => expect(canvasElement.querySelector(".nq-dialog-title")?.textContent).toBe("Remove Tomás from this document?"), { timeout: 15_000 });
    const bill = canvasElement.querySelectorAll(".nq-rotation-bill li");
    await expect(bill.length).toBe(3);
    await expect(bill[0]?.textContent).toBe("Tomás can no longer edit this document.");
    await expect(bill[1]?.textContent).toContain("keep access — their grants re-sign in this one transaction.");
    await expect(bill[2]?.textContent).toContain("see the change; other devices get it when they sync.");
    // Confirm: the epoch advances, the badge and the sentence land.
    const remove = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === "Remove");
    remove?.click();
    await waitFor(() => expect(canvasElement.querySelector(".nq-access-removed")?.textContent).toBe("removed"), { timeout: 10_000 });
  },
};

async function buildLive(mount: HTMLElement, history: HTMLElement, options: { withDialog?: boolean } = {}): Promise<void> {
  const mayaKey = await createActorKey(), tomasKey = await createActorKey();
  const ownerParty = { actorId: "human:maya", key: toBase64(mayaKey.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const relay = new NooqRelay();

  const entries = (access: Access): readonly AccessPanelEntry[] => {
    const currentEpoch = access.epoch ?? 0;
    const roll = new Set(access.revoked ?? []);
    const parties: AccessPanelEntry[] = access.grants
      .filter(g => (g.epoch ?? 0) === currentEpoch || roll.has(g.actorId))
      .map(g => (g.actorId === "human:tomas"
        ? { actorId: g.actorId, name: "Tomás", ink: "teal" as const, role: g.role, ...(roll.has(g.actorId) && (g.epoch ?? 0) !== currentEpoch ? { removed: true } : {}) }
        : { actorId: g.actorId, name: "Priya", ink: "violet" as const, role: g.role }))
      .filter(e => e.actorId !== "human:maya");
    // The removed actor stays on the roster until the surface is told to forget them.
    for (const id of roll) if (!parties.some(p => p.actorId === id) && id === "human:tomas") {
      parties.push({ actorId: id, name: "Tomás", removed: true, role: "writer", ink: "teal" });
    }
    return parties;
  };

  const render = (access: Access, removed: boolean): void => {
    mount.replaceChildren(accessPanel({ self: { actorId: "human:maya", name: "Maya", role: "writer" }, entries: entries(access) }));
    if (removed) history.replaceChildren(historyEvent("Tomás was removed from this document."));
  };

  const access0: Access = { owner: ownerParty, nonce, grants: [] };
  const doc = newDocument(docId);
  const genesis = await commitSigned(doc, tx([{ op: "setAccess" as never, access: access0 } as never]), mayaKey, "human:maya");
  const session = new SyncSession({ doc, transport: relay.connect(docId), actor: "human:maya" });
  session.start();
  session.sendUpdate(genesis.update, genesis.envelope);
  await settled();

  // Grant Tomás (writer) and Priya (reader).
  const access1: Access = { ...access0, grants: [
    { actorId: "human:tomas", key: toBase64(tomasKey.publicBytes), kind: "human", role: "writer", epoch: 0 },
    { actorId: "human:priya", key: toBase64((await createActorKey()).publicBytes), kind: "human", role: "reader" as Role, epoch: 0 },
  ] };
  const g1 = await commitSigned(doc, tx([{ op: "setAccess" as never, access: access1 } as never]), mayaKey, "human:maya");
  session.sendUpdate(g1.update, g1.envelope);
  await settled();
  render(readState(doc).access!, false);

  // Rotate: Tomás removed. With withDialog, the owner confirms the bill
  // first (the same buildRotation the commit uses — what they see is what ships).
  const before = readState(doc).access!;
  if (options.withDialog) {
    const { buildRotation } = await import("../../editor/src/index.ts");
    const { dialog } = await import("../src/index.ts");
    const preview = buildRotation(structuredClone(before) as Access, ["human:tomas"]);
    const keepers = preview.grants.filter(g => (g.epoch ?? 0) === (preview.epoch ?? 1)).length;
    const devices: number = 2; // Maya + Priya's session in this story's world
    const ul = document.createElement("ul");
    const li = (text: string) => { const item = document.createElement("li"); item.textContent = text; return item; };
    ul.append(
      li("Tomás can no longer edit this document."),
      li(`${keepers === 1 ? "1 writer and reader" : keepers + " writers and readers"} keep access — their grants re-sign in this one transaction.`),
      li(`${devices === 1 ? "1 connected device sees" : devices + " connected devices see"} the change; other devices get it when they sync.`),
    );
    const body = document.createElement("div");
    body.className = "nq-rotation-bill";
    body.append(ul);
    const note = document.createElement("p");
    note.className = "nq-ui-caption";
    note.textContent = "History keeps the removal: \"Maya was removed from this document.\"";
    body.append(note);
    const commitRotation = async (): Promise<void> => {
      const access2 = buildRotation(structuredClone(readState(doc).access!) as Access, ["human:tomas"]);
      const rotation = await commitSigned(doc, tx([{ op: "setAccess" as never, access: access2 } as never]), mayaKey, "human:maya");
      session.sendUpdate(rotation.update, rotation.envelope);
      await settled();
      render(readState(doc).access!, true);
    };
    void dialog({
      title: "Remove Tomás from this document?",
      body,
      actions: [
        { label: "Cancel" },
        { label: "Remove", variant: "danger", onClick: () => { void commitRotation(); } },
      ],
    });
    return;
  }
  const survivors = before.grants.filter(g => g.actorId !== "human:tomas").map(g => ({ ...g, epoch: 1 }));
  const access2: Access = { ...before, epoch: 1, grants: survivors, revoked: ["human:tomas"] };
  const rotation = await commitSigned(doc, tx([{ op: "setAccess" as never, access: access2 } as never]), mayaKey, "human:maya");
  session.sendUpdate(rotation.update, rotation.envelope);
  await settled();
  render(readState(doc).access!, true);
}
