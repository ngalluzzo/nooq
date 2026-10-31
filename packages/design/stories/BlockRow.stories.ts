import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, fn } from "storybook/test";
import { blockRow, caret, PEER_INKS, type BlockRowProps } from "../src/index.ts";

const meta = {
  title: "Components/BlockRow",
  render: (args) => doc(blockRow(args)),
  args: {
    content: "We shipped the offline mode to four teams in July. None of them noticed when the sync server went down for a day.",
    kind: "paragraph",
    actor: "human",
    ink: "teal",
    writer: "Tomás",
    onRestore: fn(),
  },
  argTypes: {
    content: { control: "text" },
    kind: { control: "inline-radio", options: ["paragraph", "heading", "title", "quote"] },
    actor: { control: "inline-radio", options: ["human", "ai", "importer", "migration", "system"] },
    ink: { control: "select", options: ["self", ...PEER_INKS] },
    laterEdits: { control: { type: "number", min: 0 } },
  },
  parameters: {
    docs: {
      description: {
        component:
          "One block on the writing surface with its gutter: a drag handle and a change bar showing the last writer (DM-5). Every block type, built-in or third-party, sits in a BlockRow (§7). The bar is the writer's ink, dashed pencil for AI (even once accepted), dotted for importers, migrations and the system. A deleted block stays in place, struck through, with Restore (DM-3.4, DM-4.8).",
      },
    },
  },
} satisfies Meta<BlockRowProps>;

export default meta;
type Story = StoryObj<BlockRowProps>;

function doc(...rows: Node[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "nq-doc";
  div.append(...rows);
  return div;
}

export const RemoteWriter: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("img", { name: "Last edited by Tomás" })).toBeInTheDocument();
  },
};

export const WrittenByAI: Story = {
  args: { actor: "ai", writer: "Rewrite assistant (qwen3-8b), accepted by Maya", content: "The pilot ran for six weeks across four teams; three kept using it after it ended." },
};

export const Deleted: Story = {
  args: { deleted: true, laterEdits: 2, writer: "Ines", ink: "green", content: "Pricing will be announced with the hosted service." },
  play: async ({ args, canvas, userEvent }) => {
    await expect(canvas.getByText("Deleted with 2 later edits")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Restore" }));
    await expect(args.onRestore).toHaveBeenCalledTimes(1);
  },
};

/** The handle appears on keyboard focus, not only on hover (§9). */
export const HandleOnFocus: Story = {
  play: async ({ canvas, userEvent }) => {
    const handle = canvas.getByRole("button", { name: "Move block" });
    await expect(getComputedStyle(handle).opacity).toBe("0");
    await userEvent.tab();
    await expect(handle).toHaveFocus();
    await expect(getComputedStyle(handle).opacity).toBe("1");
  },
};

export const Document: Story = {
  render: () =>
    doc(
      blockRow({ content: "Q3 field notes", kind: "title", writer: "Maya" }),
      blockRow({ content: "We shipped the offline mode to four teams in July. None of them noticed when the sync server went down for a day.", ink: "teal", writer: "Tomás" }),
      blockRow({ content: "The pilot ran for six weeks across four teams; three kept using it after it ended.", actor: "ai", writer: "Rewrite assistant (qwen3-8b), accepted by Maya" }),
      blockRow({ content: ["Next, the export path: PDF first, then DOCX", caret()], active: true, writer: "Maya" }),
      blockRow({ content: "Appendix B: survey responses, imported from field-notes-v2.docx.", actor: "importer", writer: "Docx importer" }),
      blockRow({ content: "Pricing will be announced with the hosted service.", deleted: true, laterEdits: 2, ink: "green", writer: "Ines" }),
    ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { level: 1, name: "Q3 field notes" })).toBeVisible();
    await expect(canvas.getAllByRole("button", { name: "Move block" })).toHaveLength(6);
  },
};
