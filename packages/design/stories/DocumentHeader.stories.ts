import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { NooqRelay } from "../../sync/src/index.ts";
import { Editor, createDocumentHeader, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { essentials, paragraph, title as titleBlock } from "../../plugins/src/essentials.ts";
import { button, documentHeader, presenceRoster, syncStatus } from "../src/index.ts";

/**
 * The document header (foundation P2): the strip of chrome above a writing
 * surface — the title slot leading, sync status, the roster and the host's
 * actions trailing, one rule underneath. The header is chrome (Interface
 * face): the title renders as the host binds it and is never doc-title,
 * because the Document face belongs to the surface below, where the title
 * block is edited. The component owns layout and the rule, nothing else —
 * hosts own the title's text (bind a nooq.title/v1 block or your own UI),
 * every control, and never put editing on this path (§3).
 */

const meta = {
  title: "Components/Document header",
  parameters: {
    docs: {
      description: {
        component:
          "Chrome above the surface, not content in it: title leading, sync status, presence roster and the host's actions trailing, wrapping on narrow widths, with a rule hairline below. The title slot renders as given — bind it to the document's title block or your own title UI; the header never owns text editing, and the actions slot (share, history) is the host's entry point, empty in the reference for now. Compose it with `createDocumentHeader` from `@nooq/editor`, which feeds the status and roster slots from the same status module the surface uses.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** The component alone, the way a host composes it: every slot filled. */
export const Chrome: Story = {
  render: () => documentHeader({
    title: "Quarterly plan",
    status: syncStatus({ state: "synced", count: 2 }),
    roster: presenceRoster({ self: "Maya", peers: [{ actor: "human:tomas", name: "Tomás", ink: "teal" }, { actor: "human:kai", name: "Kai", ink: "sepia", idle: true }] }),
    actions: button({ label: "Share", onClick: () => {} }),
  }),
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByText("Quarterly plan")).toBeVisible(); // the title slot renders as given
    await expect(canvas.getByText("Tomás")).toBeVisible();
    await expect(canvas.getByText("idle")).toBeVisible(); // roster state stays a word (§9)
    const share = canvas.getByRole("button", { name: "Share" });
    await userEvent.tab(); // the trailing slot holds the host's real controls, keyboard-reachable in slot order
    await expect(share).toHaveFocus();
  },
};

/** A document with no title yet: the slot renders nothing, offline is the resting state (§2). */
export const Untitled: Story = {
  render: () => documentHeader({
    title: undefined,
    status: syncStatus({ state: "local" }),
    roster: presenceRoster({ self: "Maya", peers: [] }),
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Saved on this device")).toBeVisible(); // offline looks like every other state
    await expect(canvas.queryByText("Title")).toBeNull(); // no placeholder invented for an unbound title
  },
};

/** The reference composition: a real editor's header above its surface, with a title block and a peer. */
const editors = new Set<Editor>();
interface HeaderStory { header: HTMLElement; surface: HTMLElement; titleHostId: string }
const fixtures = new WeakMap<HTMLElement, HeaderStory>();
function editorHost(): HTMLElement {
  const relay = new NooqRelay(), docId = `header-story-${crypto.randomUUID()}`;
  const writer = (actorId: string, name: string) => {
    const editor = new Editor({ docId, transport: relay.connect(docId), actor: { actorId, name }, plugins: [essentials] });
    editors.add(editor); return editor;
  };
  // The peer wrote the document first; Maya opens it (§2: offline first, then the wire).
  const tomas = writer("human:tomas", "Tomás"), maya = writer("human:maya", "Maya");
  const docTitle = tomas.insertBlock({ type: titleBlock.type, parent: null, text: "Quarterly plan" });
  const body = tomas.insertBlock({ type: paragraph.type, parent: null, text: "Sync is a background concern the writer never waits on." });
  // The host's title UI: a mirror of the bound title block, live as it is edited.
  const bound = document.createElement("span");
  const mirror = () => { bound.textContent = maya.view.blocks[docTitle]?.text?.s ?? ""; };
  mirror();
  maya.onChange(mirror);
  const header = createDocumentHeader(maya, { title: bound, selfName: "Maya" });
  const surface = createSurface(maya, { plugins: [essentialsDOM] });
  tomas.setCursor({ block: body, offset: 5 }); // a peer in the document, beside the sync line
  const page = document.createElement("div");
  page.dataset.headerDemo = "true";
  page.style.cssText = "display:flex;flex-direction:column;gap:var(--nq-space-6);max-width:calc(var(--nq-measure) + var(--nq-gutter))"; // story-only framing; components never size themselves inline
  page.append(header.element, surface.element);
  fixtures.set(page, { header: header.element, surface: surface.element, titleHostId: docTitle });
  return page;
}

export const EditorBacked: Story = {
  render: () => editorHost(),
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  play: async ({ canvasElement, userEvent }) => {
    const demo = canvasElement.querySelector<HTMLElement>("[data-header-demo]")!;
    const { header, surface, titleHostId } = fixtures.get(demo)!;

    // The surface edits the title block; the header's title slot is the host's live mirror of it.
    const titleHost = await waitFor(() => {
      const host = surface.querySelector<HTMLTextAreaElement>(`[data-nq-block="${titleHostId}"] textarea`);
      expect(host?.value).toBe("Quarterly plan");
      return host!;
    });
    await expect(header.querySelector(".nq-header-title")?.textContent).toBe("Quarterly plan");

    // The status half reads the same editor the surface reads: synced, with the peer counted.
    await waitFor(() => expect(header.querySelector<HTMLElement>(".nq-sync")!.dataset.state).toBe("synced"), { timeout: 5000 });
    await expect(header.querySelector(".nq-sync")).toHaveTextContent("Synced · 1 peer");
    const peer = await waitFor(() => {
      const chip = header.querySelector<HTMLElement>(".nq-roster-peer");
      expect(chip?.textContent).toContain("Tomás");
      return chip!;
    });
    expect(peer.style.getPropertyValue("--nq-peer")).toMatch(/^var\(--nq-peer-/); // a resolved ink, never borrowed

    // The host owns title editing: typing in the title block moves the header's title with it.
    titleHost.focus();
    titleHost.setSelectionRange(titleHost.value.length, titleHost.value.length);
    await userEvent.keyboard(" — Q3");
    await waitFor(() => expect(header.querySelector(".nq-header-title")?.textContent).toBe("Quarterly plan — Q3"));
  },
};
