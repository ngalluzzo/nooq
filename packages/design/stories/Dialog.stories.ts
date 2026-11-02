import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor, within } from "storybook/test";
import { button, dialog, type DialogHandle, type DialogOptions } from "../src/index.ts";
import { el } from "../src/dom.ts";

/**
 * The dialog (foundation P2): the modal confirmation — destructive
 * confirmations, sharing, connecting a model, export. `dialog({ title, body,
 * actions, onClose })` centers one decision in the viewport on layer-dialog,
 * labelled by its title, aria-modal. The focus discipline is the popover's:
 * Tab and Shift+Tab stay inside, focus opens on the first non-destructive
 * action, Escape or a press outside cancels (onClose, never a destructive
 * action), and focus returns to the opener. Activating an action runs its
 * handler and closes the dialog — an action is a decision, not a cancel. The
 * primary action renders rightmost; a destructive action is the danger
 * variant with a verb label. v1 has no backdrop: no scrim token exists yet,
 * so the page stays legible beneath and a press outside stands in for a
 * backdrop click. Use the popover for anchored, non-modal surfaces and the
 * notice for inline status. No in-repo flow opens a dialog yet — sharing and
 * export arrive later — so these stories are the consumer of record, the way
 * the popover shipped.
 */

/** Handles created by a render, destroyed before the next story; the plays close theirs already. */
const handles = new Set<DialogHandle>();

/** The open dialog. Dialogs are overlays, so consumers mount them on the body, outside the canvas. */
async function open(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(element).toBeTruthy();
    return element!;
  });
}

/** A trigger wired the way a consumer wires it: click toggles one dialog on the body. */
function openable(label: string, make: () => DialogOptions): HTMLButtonElement {
  let open: DialogHandle | null = null;
  return button({
    label,
    onClick: () => {
      if (open?.element.isConnected) {
        open.destroy();
        return;
      }
      open = dialog(make());
      handles.add(open);
      document.body.append(open.element);
    },
  });
}

/** The page a dialog floats over, with the outcome line each path records into. */
function page(trigger: HTMLButtonElement, outcomeText: string, proseText?: string): { host: HTMLElement; outcome: HTMLElement; prose: HTMLElement } {
  const outcome = el("span", { class: "nq-ui-caption" }, outcomeText);
  const prose = el(
    "p",
    { class: "sb-prose nq-doc-body" },
    proseText ?? "The document continues beneath the dialog, still legible; while the decision is open it cannot be reached.",
  );
  const host = el("div", { class: "sb-stack" }, el("div", { class: "sb-row" }, trigger, outcome), prose);
  return { host, outcome, prose };
}

const meta = {
  title: "Components/Dialog",
  parameters: {
    docs: {
      description: {
        component:
          "The modal confirmation (foundation P2): destructive confirmations, sharing, connecting a model, export. `dialog({ title, body, actions, onClose })` centers one decision in the viewport on `layer-dialog`, labelled by its title, `aria-modal`. The focus discipline is the popover's — Tab and Shift+Tab stay inside, focus opens on the first non-destructive action, Escape or a press outside cancels through `onClose` (never a destructive action), and focus returns to the opener. Activating an action runs its handler and closes the dialog: an action is a decision, not a cancel. The primary action renders rightmost; a destructive action is the danger variant with a verb label. v1 has no backdrop — no scrim token exists yet — so the page stays legible beneath and a press outside stands in for a backdrop click. Use the popover for anchored, non-modal surfaces and the notice for inline status. No in-repo flow opens a dialog yet (sharing and export arrive later), so these stories are the consumer of record, the way the popover shipped.",
      },
    },
  },
  beforeEach: () => {
    // Dialogs mount outside the canvas; plays close theirs, and this catches anything left open.
    for (const handle of handles) handle.destroy();
    handles.clear();
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Confirmation: Story = {
  render: () => {
    const { host, outcome } = page(
      openable("Resolve conflict", () => ({
        title: "Use Maya's version?",
        body: "Maya rewrote this paragraph after your edit. Your text stays in this block's history, and Restore brings it back.",
        actions: [
          { label: "Keep mine", variant: "quiet", onClick: () => (outcome.textContent = "Kept your version.") },
          { label: "Use Maya's", variant: "primary", onClick: () => (outcome.textContent = "Used Maya's version.") },
        ],
        onClose: (reason) => (outcome.textContent = reason === "escape" ? "Cancelled with Escape." : "Cancelled by a press outside."),
      })),
      "Two versions of this paragraph.",
    );
    return host;
  },
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Resolve conflict" });
    // Keyboard-complete (§9): open without a pointer.
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const dialog = await open();
    // A modal dialog labelled by its title.
    await expect(dialog.getAttribute("aria-modal")).toBe("true");
    await expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Use Maya's version?");
    // Centered in the viewport, whatever the theme's sizes.
    const rect = dialog.getBoundingClientRect();
    expect(Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2)).toBeLessThanOrEqual(1);
    // Actions in order, the primary rightmost.
    const actions = within(dialog).getAllByRole("button");
    await expect(actions.map((a) => a.textContent)).toEqual(["Keep mine", "Use Maya's"]);
    // Focus opened on the first non-destructive action; Tab cycles inside, wrapping at both ends.
    await waitFor(() => expect(actions[0]).toHaveFocus());
    await userEvent.tab();
    await expect(actions[1]).toHaveFocus();
    await userEvent.tab();
    await expect(actions[0]).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(actions[1]).toHaveFocus();
    // Esc cancels and focus returns to the opener.
    await userEvent.keyboard("{Escape}");
    await expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await expect(trigger).toHaveFocus();
    await expect(canvas.getByText("Cancelled with Escape.")).toBeVisible();
  },
};

export const Destructive: Story = {
  render: () => {
    const { host, outcome, prose } = page(
      openable("Delete document", () => ({
        title: "Delete this document?",
        body: "The document and its history are deleted from this device and every peer's. This cannot be undone.",
        actions: [
          { label: "Keep it", variant: "quiet", onClick: () => (outcome.textContent = "Kept the document.") },
          { label: "Delete document", variant: "danger", onClick: () => { prose.remove(); outcome.textContent = "Deleted."; } },
        ],
        onClose: (reason) => (outcome.textContent = reason === "escape" ? "Cancelled with Escape." : "Cancelled by a press outside."),
      })),
      "One document on this device.",
      "Field notes · six weeks of pilot observations across four teams.",
    );
    return host;
  },
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Delete document" });
    await userEvent.click(trigger);
    const dialog = await open();
    const actions = within(dialog).getAllByRole("button");
    // The destructive action is the danger variant with a verb label, and focus never opens on it.
    await expect(actions[1]).toHaveClass("nq-btn-danger");
    await expect(actions[1].textContent).toBe("Delete document");
    await waitFor(() => expect(actions[0]).toHaveFocus());
    await expect(actions[0].textContent).toBe("Keep it");
    // A press outside cancels — it never deletes.
    await userEvent.click(canvas.getByText(/Field notes/));
    await expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await expect(canvas.getByText(/Field notes/)).toBeVisible();
    await expect(canvas.getByText("Cancelled by a press outside.")).toBeVisible();
    // Reopen and decide: Delete removes the document, and the dialog closes itself.
    await userEvent.click(trigger);
    const again = await open();
    await userEvent.click(within(again).getByRole("button", { name: "Delete document" }));
    await expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await expect(canvas.queryByText(/Field notes/)).toBeNull();
    await expect(canvas.getByText("Deleted.")).toBeVisible();
    await expect(trigger).toHaveFocus();
  },
};

const GRANTEES = [
  "Maya · owner", "Tomás · editor", "Ines · editor", "Priya · reader", "Jonas · editor", "Ada · reader",
  "Kwame · editor", "Sofía · reader", "Ren · editor", "Amara · reader", "Lars · editor", "Yuki · reader",
  "Dario · editor", "Noor · reader", "Elio · editor", "Greta · reader", "Hana · editor", "Piotr · reader",
  "Zara · editor", "Omar · reader", "Nils · editor", "Vera · reader", "Ivo · editor", "Lucia · reader",
  "Paula · editor", "Sten · reader", "Mira · editor", "Dev · reader", "Alma · editor", "Ken · reader",
  "Rosa · editor", "Tariq · reader", "Nina · editor", "Bo · reader", "Selin · editor", "Ari · reader",
  "June · editor", "Ravi · reader", "Elsa · editor", "Kofi · reader",
];

export const LongBody: Story = {
  render: () => {
    const { host } = page(
      openable("Share document", () => ({
        title: "Share this document?",
        body: el(
          "div",
          {},
          el("p", {}, "Anyone with the link can read. Editors you grant can write."),
          el("p", {}, "Grants are append-only in v1: a grant cannot be revoked yet, and every grant is recorded in the document's access header."),
          el("ul", {}, GRANTEES.map((grant) => el("li", {}, grant))),
          el("p", {}, "Signers verify edits on their own devices; the verified glyph means their edits arrived verified here."),
        ),
        actions: [
          { label: "Not now", variant: "quiet" },
          { label: "Copy link", variant: "primary" },
        ],
      })),
      "One document, not shared.",
    );
    return host;
  },
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByRole("button", { name: "Share document" });
    await userEvent.click(trigger);
    const dialog = await open();
    // The long body scrolls inside the dialog, never the page…
    const body = dialog.querySelector<HTMLElement>(".nq-dialog-body")!;
    await waitFor(() => expect(body.scrollHeight).toBeGreaterThan(body.clientHeight));
    // …and the whole decision, title through actions, stays inside the viewport.
    const rect = dialog.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    const actions = within(dialog).getAllByRole("button");
    expect(actions[1].getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    // Esc still cancels with focus returned.
    await userEvent.keyboard("{Escape}");
    await expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await expect(trigger).toHaveFocus();
  },
};

/**
 * Mounted open, in the canvas where Storybook tears it down between stories:
 * the automatic axe check that follows every story sees the real structure —
 * the dialog role, aria-modal, the labelled title, named actions — in both
 * themes. The keyboard plays live on the stories above.
 */
export const Open: Story = {
  render: () => {
    const handle = dialog({
      title: "Connect qwen3-8b?",
      body: "Jobs run on your API key, stored on this device and never sent elsewhere. Every AI edit names this model.",
      actions: [
        { label: "Not now", variant: "quiet" },
        { label: "Connect", variant: "primary" },
      ],
    });
    handles.add(handle);
    return el(
      "div",
      { class: "sb-stack" },
      handle.element,
      el("p", { class: "sb-prose nq-doc-body" }, "A host opens this from the toolbar; until a flow consumes the dialog, these stories are the consumer of record."),
    );
  },
};
