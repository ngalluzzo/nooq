import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor, within } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { referenceDOM, referenceJobBindings, referencePlugins, simulatedRewrite } from "../../editor/src/reference.ts";
import { paragraph } from "../../plugins/src/essentials.ts";
import { draftPreview, workingState } from "../src/index.ts";

/**
 * A model at work in someone else's document: who is working, on what, with
 * Stop — and the text it is drafting, visibly not yet a proposal. The strip is
 * the AI hand on pencil-soft ground; the draft is pencil text with no wash,
 * because the wash means "proposed" and the writer has no proposal to review
 * until the job publishes one.
 */
const meta = {
  title: "Components/Working state",
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
  parameters: {
    docs: {
      description: {
        component:
          "The working state of a model job (0008). The consumer provides the job's registered binding actor (`model` is required — every AI edit says which model, DM-5), an optional DM-4 intent shown as written, and an `onStop` wired to the runtime's cancel handle; progress deltas of text-so-far render into `draftPreview`, which must stay aria-hidden — the strip's live region is the screen-reader channel (§9). Do not use it for human work, sync status, or anything but a running model job: pencil is the AI hand and nothing else (§5).",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const editors = new Set<Editor>();
const fixtures = new WeakMap<HTMLElement, { editor: Editor; surface: HTMLElement; id: string }>();

function editorFixture(text: string): HTMLElement {
  const editor = new Editor({
    docId: "working-state-story",
    actor: { actorId: "human:writer", name: "Writer" },
    plugins: referencePlugins,
    jobBindings: referenceJobBindings(),
  });
  editors.add(editor);
  const id = editor.insertBlock({ type: paragraph.type, parent: null });
  editor.editText(id, text);
  const surface = createSurface(editor, { plugins: referenceDOM });
  surface.element.dataset.workingDemo = "true";
  fixtures.set(surface.element, { editor, surface: surface.element, id });
  return surface.element;
}

function fixture(canvas: HTMLElement) {
  return fixtures.get(canvas.querySelector<HTMLElement>("[data-working-demo]")!)!;
}

export const Strip: Story = {
  render: () => {
    const stack = document.createElement("div");
    stack.className = "sb-stack";
    stack.style.maxWidth = "var(--nq-measure)";
    stack.append(
      workingState({ actor: { model: "qwen3-8b" }, onStop: () => {} }),
      workingState({ actor: { name: "Rewrite assistant", model: "qwen3-8b" }, intent: "rewrite-block", onStop: () => {} }),
      draftPreview("The pilot ran for six weeks across four teams; three kept"),
    );
    return stack;
  },
  play: async ({ canvasElement }) => {
    const [plain, full] = Array.from(canvasElement.querySelectorAll<HTMLElement>(".nq-working"));
    await expect(plain).toBeDefined();
    await expect(full).toBeDefined();
    // A polite live region: the strip is the screen-reader channel for the job.
    for (const strip of [plain, full]) {
      await expect(strip.getAttribute("role")).toBe("status");
      await expect(strip.getAttribute("aria-live")).toBe("polite");
      await expect(strip.querySelector(".nq-working-word")?.textContent).toBe("working");
      await expect(strip.querySelector(".nq-working-kind")?.textContent).toBe("AI");
    }
    // DM-5: every AI edit says which model; the intent is shown as written.
    await expect(plain.querySelector(".nq-working-model")?.textContent).toBe("qwen3-8b");
    await expect(plain.querySelector(".nq-working-intent")).toBeNull();
    await expect(full.querySelector(".nq-working-name")?.textContent).toBe("Rewrite assistant");
    await expect(full.querySelector(".nq-working-model")?.textContent).toBe("qwen3-8b");
    await expect(full.querySelector(".nq-working-intent")?.textContent).toBe("rewrite-block");
    // Stop is a quiet button carrying the stop glyph.
    const stop = plain.querySelector<HTMLButtonElement>("button")!;
    await expect(stop.textContent).toBe("Stop");
    await expect(stop.classList.contains("nq-btn-quiet")).toBe(true);
    await expect(stop.querySelector("svg[data-glyph='stop']")).not.toBeNull();
    // The draft preview is hidden from assistive technology and carries no wash.
    const draft = canvasElement.querySelector<HTMLElement>(".nq-draft")!;
    await expect(draft.getAttribute("aria-hidden")).toBe("true");
    await expect(draft.classList.contains("nq-doc-body")).toBe(true);
  },
};

const SOURCE =
  "the pilot ran for six weeks across four teams and three of them kept using the editor after it ended, which is more than we hoped for";

export const JobWithDraft: Story = {
  render: () => editorFixture(SOURCE),
  play: async ({ canvasElement }) => {
    const { editor, surface, id } = fixture(canvasElement);
    const area = surface.querySelector<HTMLTextAreaElement>("textarea")!;
    await waitFor(() => expect(area.value).toBe(SOURCE));
    const handle = editor.jobs.start(simulatedRewrite.job, { block: id });
    // The strip appears on the block it works on, naming the model (DM-5).
    await waitFor(() => expect(surface.querySelector(".nq-working")).not.toBeNull());
    const strip = surface.querySelector<HTMLElement>(".nq-working")!;
    await expect(strip.textContent).toContain("working");
    await expect(strip.textContent).toContain("AI");
    await expect(strip.querySelector(".nq-working-model")?.textContent).toBe("simulated/1");
    // The draft preview grows word by word, and never announces: aria-hidden (§9).
    const preview = () => surface.querySelector<HTMLElement>(".nq-draft")!;
    await expect(preview().getAttribute("aria-hidden")).toBe("true");
    let last = -1, grew = false;
    for (let at = 0; at < 100 && !grew; at++) {
      const length = preview().textContent?.length ?? 0;
      if (last >= 0 && length > last) grew = true;
      last = length;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    await expect(grew).toBe(true);
    await waitFor(() => expect(preview().textContent).toBe(SOURCE.charAt(0).toUpperCase() + SOURCE.slice(1)));
    // Completion settles the job: no draft, no strip — and the proposal arrives
    // through the review flow, which is the whole point: the draft was never a proposal.
    await expect(await handle.result).toMatchObject({ status: "published" });
    await waitFor(() => expect(surface.querySelector("article.nq-sugg")).not.toBeNull());
    await expect(surface.querySelector(".nq-working")).toBeNull();
    await expect(surface.querySelector(".nq-draft")).toBeNull();
    await expect(surface.querySelector("article.nq-sugg")!.textContent).toContain("simulated/1");
  },
};

export const StopCancels: Story = {
  render: () => editorFixture(SOURCE),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("textbox");
    const { editor, surface, id } = fixture(canvasElement);
    const handle = editor.jobs.start(simulatedRewrite.job, { block: id });
    await waitFor(() => expect(surface.querySelector(".nq-working")).not.toBeNull());
    const strip = surface.querySelector<HTMLElement>(".nq-working")!;
    await within(strip).getByRole("button", { name: "Stop" }).click();
    await expect(handle.result).rejects.toThrow("cancelled");
    await waitFor(() => expect(surface.querySelector(".nq-working")).toBeNull());
    await expect(surface.querySelector(".nq-draft")).toBeNull();
    await expect(surface.querySelector("article.nq-sugg")).toBeNull();
    await expect([...Object.values(editor.view.blocks)].filter(block => block.type === "nooq.suggestion/v1")).toHaveLength(0);
  },
};
