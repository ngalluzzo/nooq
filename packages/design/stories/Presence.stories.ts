import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { NooqRelay } from "../../sync/src/index.ts";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { essentials, paragraph } from "../../plugins/src/essentials.ts";
import { peerInk } from "../src/index.ts";

const editors = new Set<Editor>();
const fixtures = new WeakMap<HTMLElement, { alice: ReturnType<typeof createSurface>; bob: ReturnType<typeof createSurface>; first: string; second: string }>();
const meta = {
  title: "Collaboration/Presence",
  beforeEach: () => () => { for (const e of editors) e.close(); editors.clear(); },
  parameters: {
    docs: {
      description: {
        component: "Two writers on one relay. A remote selection paints as a CSS custom highlight in the writer's ink; the caret and name flag sit in an overlay. Neither writes into the text, so presence cannot disturb the local caret, composition or input (§3).",
      },
    },
  },
  render() {
    const relay = new NooqRelay(), docId = `presence-story-${crypto.randomUUID()}`;
    const writer = (actorId: string, name: string) => {
      const editor = new Editor({ docId, transport: relay.connect(docId), actor: { actorId, name }, plugins: [essentials] });
      editors.add(editor); return editor;
    };
    const aliceEditor = writer("human:alice", "Alice"), bobEditor = writer("human:bob", "Bob");
    const first = aliceEditor.insertBlock({ type: paragraph.type, parent: null, text: "Sync is a background concern the writer never waits on." });
    const second = aliceEditor.insertBlock({ type: paragraph.type, parent: null, text: "Every feature works in airplane mode, from the first commit." });
    const alice = createSurface(aliceEditor, { plugins: [essentialsDOM], textMode: "rich", selectionMode: "document" });
    const bob = createSurface(bobEditor, { plugins: [essentialsDOM], textMode: "rich", selectionMode: "document" });
    const column = (title: string, surface: ReturnType<typeof createSurface>) => {
      const section = document.createElement("section"), heading = document.createElement("h3");
      heading.textContent = title; section.append(heading, surface.element); return section;
    };
    const button = document.createElement("button");
    button.textContent = "Alice selects across both paragraphs";
    button.onclick = () => alice.selection!.set({ anchor: { block: first, offset: 33 }, head: { block: second, offset: 13 } });
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px";
    grid.append(column("Alice’s view", alice), column("Bob’s view", bob));
    const wrapper = document.createElement("div"); wrapper.dataset.presenceDemo = "true";
    wrapper.append(button, grid); fixtures.set(wrapper, { alice, bob, first, second }); return wrapper;
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const RemoteSelection: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    const { bob } = fixtures.get(canvasElement.querySelector<HTMLElement>("[data-presence-demo]")!)!;
    await userEvent.click(canvas.getByRole("button", { name: "Alice selects across both paragraphs" }));
    await waitFor(() => expect(bob.element.querySelector('.nq-presence [data-nq-actor="human:alice"]')).not.toBeNull());
    const registry = (globalThis as unknown as { CSS: { highlights?: Map<string, Set<AbstractRange>> } }).CSS.highlights, ink = await peerInk("human:alice");
    if (registry) await waitFor(() => expect(registry.get(`nq-peer-${ink}`)?.size).toBe(2));
  },
};
