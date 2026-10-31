import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { liveTree } from "@nooq/core";
import { Editor } from "../src/controller.ts";
import { createSurface } from "../src/dom.ts";
import { settled } from "@nooq/sync";

const DOC = "editor-test-doc";

function editorWith(actorId = "human:writer"): { editor: Editor; surface: ReturnType<typeof createSurface> } {
  const editor = new Editor({ docId: DOC, actor: { actorId, name: actorId === "human:writer" ? "Writer" : actorId } });
  const surface = createSurface(editor);
  return { editor, surface };
}

async function settle(renderRounds = 3): Promise<void> {
  await settled(renderRounds);
}

function textareaFor(surface: ReturnType<typeof createSurface>, block: string): HTMLTextAreaElement {
  const area = surface.element.querySelector<HTMLTextAreaElement>(`[data-nq-block="${block}"] textarea`);
  if (!area) throw new Error(`no textarea for ${block}`);
  return area;
}

function type(area: HTMLTextAreaElement, value: string): void {
  area.value = value;
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(area: HTMLTextAreaElement, key: string): void {
  area.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

async function card(surface: ReturnType<typeof createSurface>): Promise<HTMLElement> {
  await settle();
  const cards = Array.from(surface.element.querySelectorAll<HTMLElement>("article.nq-sugg"));
  const live = cards.find((card) => card.dataset.state !== "accepted" && card.dataset.state !== "rejected");
  if (!live) throw new Error(`no live suggestion card (states: ${cards.map((c) => c.dataset.state).join(",")})`);
  return live;
}

function clickButton(card: HTMLElement, label: string): void {
  const button = Array.from(card.querySelectorAll("button")).find((b) => b.textContent === label);
  if (!button) throw new Error(`no ${label} button`);
  button.click();
}

describe("reference editor: writing (§1 — every keystroke is a transaction)", () => {
  test("typing flows through transactions into the projection", async () => {
    const { editor, surface } = editorWith();
    const paragraph = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null });
    await settle();

    const area = textareaFor(surface, paragraph);
    area.focus();
    type(area, "hello world");
    await settle();

    expect(editor.view.blocks[paragraph]!.text!.s).toBe("hello world");
    const last = editor.view.log.at(-1)!;
    expect(last.ops[0]!.op).toBe("textEdit");
    expect(last.actor.actorId).toBe("human:writer");
    surface.destroy();
    editor.close();
  });

  test("Enter splits to a new focused paragraph; Backspace deletes empty blocks", async () => {
    const { editor, surface } = editorWith();
    const first = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "one" });
    await settle();

    const area = textareaFor(surface, first);
    area.focus();
    key(area, "Enter");
    await settle();

    const order = editor.view.roots;
    expect(order).toHaveLength(2);
    const second = order[1]!;
    expect(editor.view.blocks[second]!.type).toBe("nooq.paragraph/v1");

    const secondArea = textareaFor(surface, second);
    key(secondArea, "Backspace");
    await settle();
    expect(editor.view.roots).toHaveLength(1);
    // The empty block was tombstoned, not destroyed (DM-3.4)
    expect(editor.view.blocks[second]).toBeDefined();
    expect(liveTree(editor.view).alive.has(second)).toBe(false);
    surface.destroy();
    editor.close();
  });

  test("slash menu inserts block types; every registered row is equal (§7)", async () => {
    const { editor, surface } = editorWith();
    const paragraph = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null });
    await settle();
    const area = textareaFor(surface, paragraph);
    area.focus();
    type(area, "/");
    await settle();

    const options = Array.from(surface.element.querySelectorAll('[role="option"]'));
    expect(options.length).toBeGreaterThanOrEqual(4);
    const heading = options.find((option) => option.textContent?.includes("Heading"))!;
    heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();

    const created = editor.view.roots[1];
    expect(editor.view.blocks[created]!.type).toBe("nooq.heading/v1");
    expect(editor.view.blocks[paragraph]!.text!.s).toBe(""); // the "/" was consumed
    surface.destroy();
    editor.close();
  });
});

describe("reference editor: suggestions (§5 — AI edits are proposals)", () => {
  test("propose → card renders fresh with provenance → accept applies verbatim", async () => {
    const { editor, surface } = editorWith();
    const paragraph = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "make this shine" });
    await settle();

    await editor.propose({
      ops: [{ op: "textEdit", block: paragraph, replace: { s: "Make this shine", marks: "Make this shine".split("").map(() => []) } }],
      evidence: [paragraph],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
    const live = await card(surface);
    expect(live.dataset.state).toBe("fresh");
    expect(live.textContent).toContain("Reference assistant");
    expect(live.textContent).toContain("simulated/1");
    expect(live.textContent).toContain("rewrite-block");

    clickButton(live, "Accept");
    await settle();

    expect(editor.view.blocks[paragraph]!.text!.s).toBe("Make this shine");
    expect(editor.view.blocks[paragraph]!.attribution.text!.actor).toBe("ai:reference"); // DM-5: AI text never unattributed
    const adopt = editor.view.log.find((tx) => tx.adoptedBy === "human:writer");
    expect(adopt).toBeDefined();
    const settledCard = Array.from(surface.element.querySelectorAll<HTMLElement>("article.nq-sugg")).find((c) => c.dataset.state === "accepted");
    expect(settledCard?.textContent).toContain("accepted by");
    surface.destroy();
    editor.close();
  });

  test("drift under a waiting suggestion degrades the card to stale with Accept anyway", async () => {
    const { editor, surface } = editorWith();
    const paragraph = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "draft" });
    await settle();

    await editor.propose({
      ops: [{ op: "textEdit", block: paragraph, replace: { s: "Draft", marks: "Draft".split("").map(() => []) } }],
      evidence: [paragraph],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
    editor.editText(paragraph, "draft, edited"); // concurrent drift under the proposal
    await settle();

    const stale = await card(surface);
    expect(stale.dataset.state).toBe("stale");
    expect(stale.textContent).toContain("Accept anyway");
    clickButton(stale, "Accept anyway");
    await settle();
    expect(editor.view.blocks[paragraph]!.text!.s).toBe("Draft"); // verbatim wins (DM-6.3)
    surface.destroy();
    editor.close();
  });

  test("reject keeps the proposal in history", async () => {
    const { editor, surface } = editorWith();
    const paragraph = editor.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "keep me" });
    await settle();
    await editor.propose({
      ops: [{ op: "textEdit", block: paragraph, replace: { s: "KEEP ME", marks: [] } }],
      evidence: [paragraph],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
    const live = await card(surface);
    clickButton(live, "Reject");
    await settle();

    expect(editor.view.blocks[paragraph]!.text!.s).toBe("keep me");
    const rejectedCard = Array.from(surface.element.querySelectorAll<HTMLElement>("article.nq-sugg")).find((c) => c.dataset.state === "rejected");
    expect(rejectedCard?.textContent).toContain("kept in history");
    const suggestion = [...Object.values(editor.view.blocks)].find((b) => b.type === "nooq.suggestion/v1")!;
    expect(suggestion.fields.proposal).toBeDefined(); // payload persists (DM-6.4)
    surface.destroy();
    editor.close();
  });
});
