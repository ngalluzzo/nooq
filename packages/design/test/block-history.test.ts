/** Block history (0005): the panel's content and order, and the interactive change bar's semantics. */
import "./dom.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { blockHistoryPanel, blockRow, type BlockHistoryEntry } from "../src/index.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("blockHistoryPanel", () => {
  const entries: readonly BlockHistoryEntry[] = [
    { writer: "Maya", lamport: 41, intent: "insert:nooq.paragraph/v1" },
    { writer: "qwen3-8b", lamport: 42, intent: "rewrite-intro" },
    { writer: "Tomás", ink: "violet", lamport: 44, intent: "type" },
    { writer: "Maya", lamport: 47, intent: "rewrite-block" },
  ];

  test("renders one row per entry, newest first, whatever order the caller passes", () => {
    const panel = blockHistoryPanel({ entries });
    expect(panel.classList.contains("nq-history")).toBe(true);
    expect(panel.getAttribute("aria-label")).toBe("Block history");
    const rows = Array.from(panel.children) as HTMLLIElement[];
    expect(rows).toHaveLength(4); // exact: one row per transaction, no dedupe of the Maya runs
    expect(rows.map(row => row.querySelector(".nq-history-lamport")?.textContent)).toEqual([
      "lamport 47",
      "lamport 44",
      "lamport 42",
      "lamport 41",
    ]);
  });

  test("the lamport stays exact, in the digest face — never a relative time", () => {
    const panel = blockHistoryPanel({ entries: [{ writer: "Maya", lamport: 42 }] });
    const lamport = panel.querySelector(".nq-history-lamport")!;
    expect(lamport.textContent).toBe("lamport 42");
    expect(lamport.classList.contains("nq-digest")).toBe(true);
  });

  test("the writer is an ActorChip, carrying a passed peer ink; machine kinds read as words (DM-5)", () => {
    const panel = blockHistoryPanel({ entries: [...entries, { writer: "Docx importer", kind: "importer", lamport: 45 }] });
    const chip = Array.from(panel.querySelectorAll(".nq-actor")).find(node => (node as HTMLElement).textContent?.includes("Tomás")) as HTMLElement;
    expect(chip).toBeDefined();
    expect(chip.style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-violet)");
    // A writer without an ink keeps the local writer's default, not a borrowed color.
    const local = Array.from(panel.querySelectorAll(".nq-actor")).find(node => (node as HTMLElement).textContent?.includes("Maya")) as HTMLElement;
    expect(local.style.getPropertyValue("--nq-peer")).toBe("var(--nq-ink)");
    const importer = Array.from(panel.querySelectorAll(".nq-actor")).find(node => (node as HTMLElement).textContent?.includes("Docx importer")) as HTMLElement;
    expect(importer.classList.contains("nq-actor-importer")).toBe(true);
    expect(importer.textContent).toContain("Importer");
  });

  test("the intent appears as written, in ui-caption; absent intents render nothing", () => {
    const panel = blockHistoryPanel({ entries: [{ writer: "Maya", lamport: 40 }, { writer: "Tomás", lamport: 41, intent: "rewrite-intro" }] });
    const intents = Array.from(panel.querySelectorAll(".nq-history-intent"));
    expect(intents).toHaveLength(1);
    expect(intents[0]!.textContent).toBe("rewrite-intro");
    expect(intents[0]!.classList.contains("nq-ui-caption")).toBe(true);
  });

  test("an optional Restore row: a quiet button with the undo glyph", () => {
    const onRestore = mock(() => {});
    const panel = blockHistoryPanel({ entries: [{ writer: "Maya", lamport: 42 }], onRestore });
    const restore = panel.querySelector<HTMLButtonElement>(".nq-history-restore .nq-btn")!;
    expect(restore.textContent).toContain("Restore");
    expect(restore.classList.contains("nq-btn-quiet")).toBe(true);
    expect(restore.querySelector("[data-glyph='undo']")).not.toBeNull();
    restore.click();
    expect(onRestore).toHaveBeenCalledTimes(1);
    // Absent onRestore: no action row at all.
    expect(blockHistoryPanel({ entries: [{ writer: "Maya", lamport: 42 }] }).querySelector(".nq-history-restore")).toBeNull();
  });
});

describe("blockRow's interactive change bar", () => {
  const bar = (row: HTMLDivElement): HTMLElement => row.querySelector(".nq-bar")!;

  test("with onHistory the bar is a button named for the last writer, with no title attribute", () => {
    const onHistory = mock(() => {});
    const row = blockRow({ content: "text", writer: "Maya", onHistory });
    const control = bar(row);
    expect(control.tagName).toBe("BUTTON");
    expect((control as HTMLButtonElement).type).toBe("button");
    expect(control.getAttribute("aria-label")).toBe("Block history · last edited by Maya");
    expect(control.hasAttribute("title")).toBe(false); // the tooltip replaces it
    expect(control.classList.contains("nq-bar-history")).toBe(true);
    control.click();
    expect(onHistory).toHaveBeenCalledTimes(1);
  });

  test("without onHistory the bar stays the plain attribution mark", () => {
    const row = blockRow({ content: "text", writer: "Maya" });
    const mark = bar(row);
    expect(mark.tagName).toBe("SPAN");
    expect(mark.getAttribute("role")).toBe("img");
    expect(mark.getAttribute("aria-label")).toBe("Last edited by Maya");
    expect(mark.getAttribute("title")).toBe("Last edited by Maya");
    expect(mark.classList.contains("nq-bar-history")).toBe(false);
  });

  test("the bar keeps its writer color and the deleted variant keeps the plain bar", () => {
    const row = blockRow({ content: "text", writer: "Tomás", ink: "teal", onHistory: () => {} });
    expect(row.style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-teal)"); // the bar inherits it
    const deleted = blockRow({ content: "gone", deleted: true, laterEdits: 2, onRestore: () => {} });
    expect(deleted.classList.contains("nq-block-deleted")).toBe(true);
    expect(bar(deleted).tagName).toBe("SPAN");
    expect(deleted.textContent).toContain("Deleted with 2 later edits");
  });

  test("the tooltip opens on hover and on keyboard focus of the bar", () => {
    document.body.append(
      blockRow({
        content: "text",
        writer: "Maya",
        onHistory: () => {
          const tip = document.querySelector('[role="tooltip"]');
          if (tip) throw new Error("history opened");
        },
      }),
    );
    const control = document.querySelector<HTMLButtonElement>(".nq-bar-history")!;
    control.dispatchEvent(new Event("pointerenter"));
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip?.textContent).toBe("Last edited by Maya");
    expect(control.getAttribute("aria-describedby")).toBe(tip !== null ? tip.id : null);
    control.dispatchEvent(new Event("pointerleave"));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    control.dispatchEvent(new Event("focusin", { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Last edited by Maya");
    control.dispatchEvent(new Event("focusout", { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
