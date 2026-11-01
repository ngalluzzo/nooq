import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, fn, waitFor, within } from "storybook/test";
import { blockHistoryPanel, blockRow, popover, type BlockHistoryEntry, type PopoverHandle } from "../src/index.ts";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { referenceDOM, referenceJobBindings, referencePlugins } from "../../editor/src/reference.ts";

/**
 * Block history (0005): from a change bar to a block's past. The bar is the
 * entrance — click it (or focus it and press Enter) and the transactions that
 * touched the block list newest first: who, the DM-4 intent as written, and
 * the lamport EXACT, in the digest face. A machine's number is never
 * translated into "a moment ago". A deleted block stays reachable below the
 * document, struck through, with Restore.
 */

const ENTRIES: readonly BlockHistoryEntry[] = [
  { writer: "Maya", lamport: 41, intent: "insert:nooq.paragraph/v1" },
  { writer: "qwen3-8b", kind: "ai", lamport: 42, intent: "rewrite-intro" },
  { writer: "Tomás", ink: "violet", lamport: 44, intent: "type" },
  { writer: "Maya", lamport: 47, intent: "rewrite-block" },
];

const meta = {
  title: "Components/Block history",
  parameters: {
    docs: {
      description: {
        component:
          "The panel behind the interactive change bar, and the deleted flow's Restore. One row per transaction (DM-14.4), newest first: the writer as an ActorChip carrying a remote human's derived ink, the intent as written in ui-caption, and the lamport exact in the digest face. Give it `onRestore` only for a tombstoned block. The bar opens it: mount the panel in a `popover()` anchored to the `.nq-bar-history` button.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** The panel alone, the way a host composes it. */
export const Panel: Story = {
  render: () => {
    const host = document.createElement("div");
    host.className = "nq-doc";
    host.style.maxWidth = "420px"; // story-only framing; components never size themselves inline
    host.append(blockHistoryPanel({ entries: ENTRIES }));
    return host;
  },
  play: async ({ canvas }) => {
    const rows = canvas.getAllByRole("listitem");
    await expect(rows).toHaveLength(4); // exact: one row per transaction, the Maya runs are not merged
    const lamports = rows.map(row => within(row).getByText(/^lamport \d+$/).textContent);
    await expect(lamports).toEqual(["lamport 47", "lamport 44", "lamport 42", "lamport 41"]); // newest first
    await expect(canvas.getByText("rewrite-intro")).toHaveClass("nq-history-intent");
    const ai = within(rows[2]!).getByText("qwen3-8b").closest(".nq-actor")!;
    await expect(ai).toHaveClass("nq-actor-ai"); // the AI writer reads as a word (DM-5), never just a name
    const chip = within(rows[1]!).getByText("Tomás").closest(".nq-actor") as HTMLElement;
    await expect(chip.style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-violet)"); // the peer's derived ink
  },
};

/** The deleted flow's panel: the same history, with the Restore row. */
interface RestoreArgs { onRestore: () => void }
export const PanelWithRestore: StoryObj<RestoreArgs> = {
  args: { onRestore: fn() },
  render: ({ onRestore }) => {
    const host = document.createElement("div");
    host.className = "nq-doc";
    host.style.maxWidth = "420px";
    host.append(blockHistoryPanel({ entries: [{ writer: "Ines", ink: "green", lamport: 52, intent: "delete" }, { writer: "Maya", lamport: 47, intent: "rewrite-block" }], onRestore }));
    return host;
  },
  play: async ({ canvas, args }) => {
    await expect(canvas.getAllByRole("listitem")).toHaveLength(3);
    await expect(canvas.getByText("lamport 52")).toBeVisible();
    const restore = canvas.getByRole("button", { name: "Restore" });
    await expect(restore.querySelector("[data-glyph='undo']")).not.toBeNull();
    restore.click();
    await expect(args.onRestore).toHaveBeenCalledTimes(1);
  },
};

/** The interactive bar: a button with a tooltip on hover AND focus, opening the panel in a popover. */
export const InteractiveBar: Story = {
  render: () => {
    const host = document.createElement("div");
    host.className = "nq-doc";
    let open: PopoverHandle | null = null;
    const row = blockRow({
      content: "We shipped the offline mode to four teams in July.",
      writer: "Maya",
      onHistory: () => {
        open?.destroy();
        open = popover({ anchor: row.querySelector<HTMLElement>(".nq-bar-history")!, content: blockHistoryPanel({ entries: ENTRIES }) });
        document.body.append(open.element);
      },
    });
    host.append(row);
    return host;
  },
  play: async ({ canvas, userEvent }) => {
    const bar = canvas.getByRole("button", { name: "Block history · last edited by Maya" });
    await expect(bar).not.toHaveAttribute("title"); // the tooltip replaces the title attribute
    await userEvent.hover(bar);
    const tip = within(document.body).getByRole("tooltip");
    await expect(tip).toHaveTextContent("Last edited by Maya");
    await userEvent.unhover(bar);
    await userEvent.tab(); // handle first
    await userEvent.tab();
    await expect(bar).toHaveFocus();
    await expect(within(document.body).getByRole("tooltip")).toHaveTextContent("Last edited by Maya"); // focus reaches it too (§9)
    await userEvent.click(bar);
    const panel = await waitFor(() => within(document.body).getByRole("list", { name: "Block history" }));
    await expect(within(panel).getAllByRole("listitem")).toHaveLength(4);
  },
};

/** The whole flow on a real editor: keyboard in, keyboard out, and Restore for a deleted block. */
const editors = new Set<Editor>();
function editorHost(): HTMLElement {
  const editor = new Editor({ docId: crypto.randomUUID(), plugins: referencePlugins, jobBindings: referenceJobBindings(), actor: { actorId: "human:story", name: "Maya" } });
  editors.add(editor);
  const surface = createSurface(editor, { plugins: referenceDOM });
  editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "The pilot ran for six weeks." });
  editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "Pricing will be announced with the hosted service." });
  queueMicrotask(() => { try { editor.deleteBlock(editor.view.roots[1]!); } catch { /* the block may have moved; the play assertions decide */ } });
  const page = document.createElement("div");
  page.className = "nq-doc";
  page.append(surface.element);
  return page;
}

export const EditorBacked: Story = {
  render: () => editorHost(),
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  play: async ({ userEvent }) => {
    const surface = document.querySelector(".nq-editor")! as HTMLElement;
    // Plain text hosts are textareas: their text is a value, not text content.
    const pilot = await waitFor(() => {
      const host = surface.querySelector<HTMLTextAreaElement>("[data-nq-block] textarea");
      expect(host?.value).toBe("The pilot ran for six weeks.");
      return host!;
    });

    // The deleted block stays reachable below the document (DM-3.4).
    const deleted = await waitFor(() => {
      const row = surface.querySelector<HTMLElement>(".nq-history-layer .nq-block-deleted");
      expect(row).not.toBeNull();
      return row!;
    });
    await expect(within(deleted).getByText("Deleted")).toBeVisible();
    await expect(within(deleted).getByText("Pricing will be announced with the hosted service.")).toBeVisible();

    // Keyboard in: the bar focuses, Enter opens the history popover.
    const bar = within(surface).getAllByRole("button", { name: /Block history · last edited by / })[0]!;
    bar.focus();
    await expect(bar).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const panel = await waitFor(() => within(document.body).getByRole("list", { name: "Block history" }));
    const rows = within(panel).getAllByRole("listitem");
    await expect(rows.length).toBeGreaterThanOrEqual(1); // one row per touching transaction
    await expect(within(panel).getAllByText(/^lamport \d+$/).length).toBe(rows.length); // exact lamports, never relative times

    // Keyboard out: Escape closes and focus returns to the bar (the popover's contract).
    await userEvent.keyboard("{Escape}");
    await expect(within(document.body).queryByRole("list", { name: "Block history" })).toBeNull();
    await expect(bar).toHaveFocus();

    // Restore brings the deleted block back.
    await userEvent.click(within(deleted).getByRole("button", { name: "Restore" }));
    await waitFor(() => {
      const restored = Array.from(surface.querySelectorAll<HTMLTextAreaElement>("textarea")).find(area => area.value === "Pricing will be announced with the hosted service.");
      expect(restored).toBeDefined();
    });
    await expect(surface.querySelector(".nq-history-layer .nq-block-deleted")).toBeNull();
    expect(pilot.value).toBe("The pilot ran for six weeks."); // restore touched only the deleted block
  },
};
