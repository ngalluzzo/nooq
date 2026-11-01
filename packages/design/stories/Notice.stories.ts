import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, fn } from "storybook/test";
import { notice, type NoticeKind, type NoticeProps } from "../src/index.ts";
import { grid, row } from "./fixtures.ts";

const KINDS: readonly NoticeKind[] = ["error", "hold", "denial", "model"];

const meta = {
  title: "Components/Notice",
  render: (args) => notice(args),
  args: { kind: "error", word: "Callouts could not load: the plugin returned invalid JSON." },
  argTypes: { kind: { control: "inline-radio", options: KINDS }, word: { control: "text" } },
  parameters: {
    docs: {
      description: {
        component:
          "An inline, non-blocking notice: a word, a glyph, an optional action. The consumer provides the word — one sentence naming the actor or cause, no \"please\", no exclamation marks — and the placement: beside the writing surface, never over the input path (§2, §3). Wire it to `editor.errors` and authorization refusals; a hold (0001, retryable) reads patiently in graphite-muted while a denial states its reason in a rule-strong outline. Not for sync status (SyncStatus owns that) and never for destructive confirmation. `stamp` never appears here: stamp means structure broke, and that is the conflicted state's word.",
      },
    },
  },
} satisfies Meta<NoticeProps>;

export default meta;
type Story = StoryObj<NoticeProps>;

export const Error: Story = {
  play: async ({ canvas }) => {
    const notice1 = canvas.getByRole("status");
    await expect(notice1).toHaveAttribute("aria-live", "polite");
    await expect(notice1.querySelector("svg[data-glyph='warning']")).toBeInTheDocument();
  },
};

export const Hold: Story = {
  args: { kind: "hold", word: "Waiting for access" },
  play: async ({ canvas }) => {
    const hold = canvas.getByRole("status");
    await expect(hold).toHaveAttribute("data-kind", "hold");
    await expect(hold.querySelector("svg[data-glyph='access']")).toBeInTheDocument();
  },
};

export const Denial: Story = {
  args: { kind: "denial", word: "Access denied: only signed writers can edit this section." },
  play: async ({ canvas }) => {
    const denial = canvas.getByRole("status");
    await expect(denial).toHaveAttribute("data-kind", "denial");
    await expect(denial.querySelector("svg[data-glyph='stop']")).toBeInTheDocument();
  },
};

export const ModelError: Story = {
  args: { kind: "model", word: "qwen3-8b stopped mid-draft. The block was not changed." },
  play: async ({ canvas }) => {
    const model = canvas.getByRole("status");
    await expect(model).toHaveAttribute("data-kind", "model");
    await expect(model.querySelector("svg[data-glyph='model']")).toBeInTheDocument();
  },
};

const onRetry = fn();

export const WithAction: Story = {
  args: { kind: "hold", word: "Waiting for access" },
  render: (args) => notice({ ...args, action: { label: "Retry", onClick: onRetry } }),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  },
};

/** Long values a machine produced stay exact (brand book) and wrap where they land. */
export const LongWord: Story = {
  args: {
    kind: "error",
    word: "Structure mismatch: sha256:177298c3e4a1b9d07f62e5a8c1b3d4e5f60718293a4b5c6d7e8f90a1b2c3cfd7 no longer matches block 42.",
  },
  render: (args) => row(notice(args)),
  play: async ({ canvasElement }) => {
    const word = canvasElement.querySelector<HTMLElement>(".nq-notice-word")!;
    // The word wraps instead of overflowing its notice.
    expect(word.scrollWidth).toBeLessThanOrEqual(word.clientWidth);
  },
};

export const AllKinds: Story = {
  render: () =>
    grid(
      ...KINDS.map((kind) =>
        notice({
          kind,
          word:
            kind === "hold" ? "Waiting for access" :
            kind === "denial" ? "Access denied: only signed writers can edit this section." :
            kind === "model" ? "qwen3-8b stopped mid-draft. The block was not changed." :
            "Callouts could not load: the plugin returned invalid JSON.",
        }),
      ),
    ),
  play: async ({ canvasElement }) => {
    const notices = Array.from(canvasElement.querySelectorAll(".nq-notice"));
    expect(notices).toHaveLength(KINDS.length);
    // Every kind keeps its own glyph, so no state depends on color alone (§9).
    const glyphs = notices.map((n) => n.querySelector("svg")!.getAttribute("data-glyph"));
    expect(new Set(glyphs).size).toBe(KINDS.length);
    // Inline and non-blocking: a live region, never a modal, on no input path.
    for (const n of notices) {
      expect(n.getAttribute("role")).toBe("status");
      expect(n.hasAttribute("aria-modal")).toBe(false);
    }
  },
};
