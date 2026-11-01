import "./dom.ts";
import { describe, expect, mock, test } from "bun:test";
import {
  actorChip,
  blockRow,
  button,
  caret,
  deletedLabel,
  digest,
  glyph,
  presenceCaret,
  slashMenu,
  stateTag,
  SUGGESTION_STATES,
  suggestionCard,
  syncStatus,
  syncText,
  toAriaShortcut,
  truncateDigest,
  type SlashMenuItem,
  type SyncState,
} from "../src/index.ts";

const DIGEST = "sha256:9f2c1a7be0d44c1f8a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6fe81a";
const key = (target: Element, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("button", () => {
  test("renders a type=button with the label and variant class", () => {
    const b = button({ label: "Accept", variant: "primary" });
    expect(b.type).toBe("button");
    expect(b.textContent).toBe("Accept");
    expect(b.classList.contains("nq-btn-primary")).toBe(true);
  });

  test("default variant adds no modifier class", () => {
    expect(button({ label: "Accept anyway" }).className).toBe("nq-btn nq-ui-label");
  });

  test("a shortcut renders as a hint and is exposed to assistive technology", () => {
    const b = button({ label: "Accept", shortcut: "⌘↵" });
    expect(b.querySelector("kbd")?.textContent).toBe("⌘↵");
    expect(b.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
  });

  test("calls onClick, and not when disabled", () => {
    const onClick = mock(() => {});
    button({ label: "Restore", onClick }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
    const disabled = button({ label: "Restore", onClick, disabled: true });
    expect(disabled.disabled).toBe(true);
  });

  test("toAriaShortcut maps symbols to key names", () => {
    expect(toAriaShortcut("⌘⇧↵")).toBe("Meta+Shift+Enter");
    expect(toAriaShortcut("⌃K")).toBe("Control+K");
  });
});

describe("actorChip", () => {
  test("a human shows a name and their ink, and no kind word", () => {
    const chip = actorChip({ name: "Tomás", ink: "violet" });
    expect(chip.textContent).toBe("Tomás");
    expect(chip.style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-violet)");
  });

  test("the local writer is ink", () => {
    expect(actorChip({ name: "Maya" }).style.getPropertyValue("--nq-peer")).toBe("var(--nq-ink)");
  });

  test("an AI shows its model and the word AI (§5)", () => {
    const chip = actorChip({ kind: "ai", name: "Rewrite assistant", model: "qwen3-8b" });
    expect(chip.querySelector(".nq-actor-model")?.textContent).toBe("qwen3-8b");
    expect(chip.querySelector(".nq-actor-kind")?.textContent).toBe("AI");
    expect(chip.style.getPropertyValue("--nq-peer")).toBe("");
  });

  test.each([
    ["importer", "Importer"],
    ["migration", "Migration"],
    ["system", "System"],
  ] as const)("a %s is labeled as a word, never by hue", (kind, word) => {
    const chip = actorChip({ kind, name: "x" });
    expect(chip.querySelector(".nq-actor-kind")?.textContent).toBe(word);
    expect(chip.classList.contains(`nq-actor-${kind}`)).toBe(true);
  });

  test("the color mark is decorative", () => {
    expect(actorChip({ name: "Maya" }).querySelector(".nq-actor-mark")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("digest", () => {
  test("truncates to first 6 and last 4 hex digits", () => {
    expect(truncateDigest(DIGEST)).toBe("9f2c1a…e81a");
    expect(truncateDigest("sha256:abc")).toBe("abc");
  });

  test("shows the algorithm and the kind, and keeps the full value readable", () => {
    const d = digest({ value: DIGEST, kind: "content" });
    expect(d.querySelector(".nq-digest-kind")?.textContent).toBe("content");
    expect(d.textContent).toStartWith("contentsha256:9f2c1a…e81a");
    expect(d.title).toBe(DIGEST);
  });

  test("its accessible name begins with the visible text (WCAG 2.5.3)", () => {
    const d = digest({ value: DIGEST });
    expect(d.hasAttribute("aria-label")).toBe(false);
    expect(d.textContent).toBe("sha256:9f2c1a…e81a(copy full value)");
  });

  test("click copies the full value, not the truncated one", () => {
    const copy = mock((_: string) => {});
    digest({ value: DIGEST, copy }).click();
    expect(copy).toHaveBeenCalledWith(DIGEST);
  });

  test("a refused clipboard is swallowed", async () => {
    const copy = mock(() => Promise.reject(new Error("denied")));
    expect(() => digest({ value: DIGEST, copy }).click()).not.toThrow();
    await Promise.resolve();
    const throwing = () => {
      throw new Error("no clipboard");
    };
    expect(() => digest({ value: DIGEST, copy: throwing }).click()).not.toThrow();
  });
});

describe("glyphs", () => {
  const chrome = ["close", "more", "chevron", "undo", "redo", "history", "access", "verified", "model", "warning", "stop"] as const;

  test("the chrome set the P0 components need: geometric, decorative, one shape each", () => {
    for (const name of chrome) {
      const g = glyph(name);
      expect(g.getAttribute("aria-hidden")).toBe("true");
      expect(g.getAttribute("data-glyph")).toBe(name);
      expect(g.innerHTML).not.toBe("");
    }
    expect(new Set(chrome.map((name) => glyph(name).innerHTML)).size).toBe(chrome.length);
  });

  test("a chrome glyph never reuses a state glyph's shape, so a shape keeps its meaning", () => {
    const states = SUGGESTION_STATES.map((state) => stateTag({ state }).querySelector("svg")!.innerHTML);
    for (const name of chrome) expect(states).not.toContain(glyph(name).innerHTML);
  });
});

describe("stateTag", () => {
  test.each(SUGGESTION_STATES.map((s) => [s]))("%s shows the spec word, a glyph and its class", (state) => {
    const tag = stateTag({ state });
    expect(tag.textContent).toBe(state);
    expect(tag.querySelector(`svg[data-glyph="${state}"]`)?.getAttribute("aria-hidden")).toBe("true");
    expect(tag.classList.contains(`nq-state-${state}`)).toBe(true);
  });

  test("every state has its own glyph", () => {
    const shapes = SUGGESTION_STATES.map((state) => stateTag({ state }).querySelector("svg")!.innerHTML);
    expect(new Set(shapes).size).toBe(SUGGESTION_STATES.length);
  });
});

describe("suggestionCard", () => {
  const base = {
    actor: "Rewrite assistant",
    model: "qwen3-8b",
    intent: "tighten-intro",
    diff: [{ text: "The pilot ran " }, { del: "and most teams liked it" }, { ins: "across four teams" }, { text: "." }],
    evidence: [{ kind: "content", value: DIGEST }],
    reason: "Maya edited this paragraph after the proposal was made.",
  };

  test("renders the exact diff: insertions as <ins>, deletions as <del>", () => {
    const card = suggestionCard({ ...base, state: "fresh" });
    expect(card.querySelector("ins")?.textContent).toBe("across four teams");
    expect(card.querySelector("del")?.textContent).toBe("and most teams liked it");
    expect(card.querySelector(".nq-sugg-diff")?.textContent).toBe("The pilot ran and most teams liked itacross four teams.");
  });

  test("names the actor, model, state and intent", () => {
    const card = suggestionCard({ ...base, state: "fresh" });
    expect(card.getAttribute("aria-label")).toBe("Suggestion from Rewrite assistant, fresh");
    expect(card.querySelector(".nq-actor-model")?.textContent).toBe("qwen3-8b");
    expect(card.querySelector(".nq-state")?.textContent).toBe("fresh");
    expect(card.querySelector(".nq-sugg-intent")?.textContent).toBe("tighten-intro");
  });

  test("fresh: Accept is primary and carries the shortcut", () => {
    const card = suggestionCard({ ...base, state: "fresh", acceptShortcut: "⌘↵" });
    const [accept, reject] = Array.from(card.querySelectorAll("button.nq-btn"));
    expect(accept!.textContent).toBe("Accept⌘↵");
    expect(accept!.classList.contains("nq-btn-primary")).toBe(true);
    expect(reject!.textContent).toBe("Reject");
  });

  test.each([["stale"], ["conflicted"]] as const)("%s: 'Accept anyway' at default weight, with the reason (DM-6.3)", (state) => {
    const card = suggestionCard({ ...base, state, acceptShortcut: "⌘↵" });
    const accept = card.querySelector("button.nq-btn")!;
    expect(accept.textContent).toBe("Accept anyway");
    expect(accept.classList.contains("nq-btn-primary")).toBe(false);
    expect(card.querySelector(".nq-sugg-reason")?.textContent).toBe(base.reason);
  });

  test("Accept and Reject call their handlers", () => {
    const onAccept = mock(() => {});
    const onReject = mock(() => {});
    const card = suggestionCard({ ...base, state: "stale", onAccept, onReject });
    const [accept, reject] = Array.from(card.querySelectorAll<HTMLButtonElement>("button.nq-btn"));
    accept!.click();
    reject!.click();
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  test("accepted: records both actors (DM-5 adoption provenance), no actions, no evidence", () => {
    const card = suggestionCard({ ...base, state: "accepted", settledBy: "Maya" });
    expect(card.querySelector(".nq-sugg-settled")?.textContent).toBe("Proposed by qwen3-8b · accepted by Maya");
    expect(card.querySelector("button.nq-btn")).toBeNull();
    expect(card.querySelector(".nq-sugg-evidence")).toBeNull();
    expect(card.querySelector(".nq-sugg-reason")).toBeNull();
  });

  test("rejected: kept in history (DM-6.4)", () => {
    const card = suggestionCard({ ...base, state: "rejected", settledBy: "Maya" });
    expect(card.querySelector(".nq-sugg-settled")?.textContent).toBe("Rejected by Maya · kept in history");
  });

  test("evidence renders one digest per entry", () => {
    const card = suggestionCard({ ...base, state: "fresh", evidence: [...base.evidence, { kind: "structure", value: DIGEST }] });
    expect(card.querySelectorAll(".nq-digest-chip").length).toBe(2);
  });
});

describe("blockRow", () => {
  test("renders content in the right element and type style", () => {
    expect(blockRow({ content: "Q3 field notes", kind: "title" }).querySelector("h1.nq-doc-title")?.textContent).toBe("Q3 field notes");
    expect(blockRow({ content: "x", kind: "heading" }).querySelector("h2.nq-doc-h2")).not.toBeNull();
    expect(blockRow({ content: "x", kind: "quote" }).querySelector("blockquote.nq-doc-quote")).not.toBeNull();
    expect(blockRow({ content: "x" }).querySelector("p.nq-doc-body")).not.toBeNull();
  });

  test.each([
    ["human", "nq-bar-human"],
    ["ai", "nq-bar-ai"],
    ["importer", "nq-bar-machine"],
    ["migration", "nq-bar-machine"],
    ["system", "nq-bar-machine"],
  ] as const)("a %s last writer gets %s", (actor, cls) => {
    expect(blockRow({ content: "x", actor }).querySelector(".nq-bar")?.classList.contains(cls)).toBe(true);
  });

  test("a human writer's ink colors the bar; machines get none", () => {
    expect(blockRow({ content: "x", ink: "teal" }).style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-teal)");
    expect(blockRow({ content: "x", actor: "ai" }).style.getPropertyValue("--nq-peer")).toBe("");
  });

  test("the change bar announces its writer", () => {
    const bar = blockRow({ content: "x", writer: "Tomás" }).querySelector(".nq-bar")!;
    expect(bar.getAttribute("role")).toBe("img");
    expect(bar.getAttribute("aria-label")).toBe("Last edited by Tomás");
  });

  test("the drag handle is a labeled button", () => {
    expect(blockRow({ content: "x" }).querySelector("button.nq-handle")?.getAttribute("aria-label")).toBe("Move block");
  });

  test("a deleted block stays in place, struck, with Restore (DM-3.4)", () => {
    const onRestore = mock(() => {});
    const row = blockRow({ content: "Pricing later.", deleted: true, laterEdits: 2, onRestore });
    expect(row.querySelector("del")?.textContent).toBe("Pricing later.");
    expect(row.querySelector(".nq-tomb-meta span")?.textContent).toBe("Deleted with 2 later edits");
    row.querySelector<HTMLButtonElement>(".nq-tomb-meta button")!.click();
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  test("deletedLabel pluralizes and omits zero (DM-4.8)", () => {
    expect(deletedLabel(0)).toBe("Deleted");
    expect(deletedLabel(1)).toBe("Deleted with 1 later edit");
    expect(deletedLabel(3)).toBe("Deleted with 3 later edits");
  });
});

describe("presenceCaret", () => {
  test("renders the flag, the selection, and a screen-reader name", () => {
    const p = presenceCaret({ name: "Ines", ink: "green", selection: "airplane mode" });
    expect(p.style.getPropertyValue("--nq-peer")).toBe("var(--nq-peer-green)");
    expect(p.querySelector(".nq-peer-sel")?.textContent).toBe("airplane mode");
    expect(p.querySelector(".nq-peer-flag")?.textContent).toBe("Ines");
    expect(p.querySelector(".nq-peer-caret")?.getAttribute("aria-hidden")).toBe("true");
    expect(p.querySelector(".nq-sr")?.textContent).toBe("Ines’s cursor");
  });

  test("omits the selection when there is none", () => {
    expect(presenceCaret({ name: "Ines", ink: "green" }).querySelector(".nq-peer-sel")).toBeNull();
  });

  test("the local caret is decorative", () => {
    expect(caret().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("slashMenu", () => {
  const items: SlashMenuItem[] = [
    { label: "Paragraph", type: "nooq.paragraph/v1", glyph: "¶" },
    { label: "Heading 2", type: "nooq.heading/v1", glyph: "H2", hint: "##" },
    { label: "Callout", type: "acme.callout/v2" },
    { label: "Draft with AI", type: "nooq.suggestion/v1", glyph: "AI", ai: true },
  ];
  const listbox = (m: HTMLElement) => m.querySelector<HTMLElement>('[role="listbox"]')!;
  const selected = (m: HTMLElement) => Array.from(m.querySelectorAll('[role="option"]')).findIndex((o) => o.getAttribute("aria-selected") === "true");

  test("lists every block the same way, built-in or third-party (§7)", () => {
    const m = slashMenu({ items });
    const rows = Array.from(m.querySelectorAll('[role="option"]'));
    expect(rows.map((r) => r.querySelector(".nq-menu-type")?.textContent)).toEqual(items.map((i) => i.type));
    expect(new Set(rows.map((r) => r.className.replace(/\s*is-active/, ""))).size).toBe(1);
  });

  test("glyph defaults to the label's first letter; AI items get the pencil glyph", () => {
    const m = slashMenu({ items });
    const glyphs = Array.from(m.querySelectorAll(".nq-menu-glyph"));
    expect(glyphs[2]!.textContent).toBe("C");
    expect(glyphs[3]!.classList.contains("is-ai")).toBe(true);
  });

  test("only option rows live inside the listbox", () => {
    const m = slashMenu({ items, query: "he" });
    for (const child of Array.from(listbox(m).children)) expect(child.getAttribute("role")).toBe("option");
    expect(listbox(m).getAttribute("aria-label")).toBe("Insert block, filtered by “he”");
    expect(m.querySelector(".nq-menu-query")?.textContent).toBe("/he");
  });

  test("tracks the active row with aria-activedescendant", () => {
    const m = slashMenu({ items, active: 1 });
    expect(selected(m)).toBe(1);
    expect(listbox(m).getAttribute("aria-activedescendant")).toBe(m.querySelectorAll('[role="option"]')[1]!.id);
  });

  test("clamps an out-of-range active index", () => {
    expect(selected(slashMenu({ items, active: 99 }))).toBe(items.length - 1);
  });

  test("arrows wrap, Home and End jump (§9)", () => {
    const m = slashMenu({ items });
    key(listbox(m), "ArrowUp");
    expect(selected(m)).toBe(3);
    key(listbox(m), "ArrowDown");
    expect(selected(m)).toBe(0);
    key(listbox(m), "End");
    expect(selected(m)).toBe(3);
    key(listbox(m), "Home");
    expect(selected(m)).toBe(0);
  });

  test("Enter selects the active row; Escape closes", () => {
    const onSelect = mock((_item: SlashMenuItem, _i: number) => {});
    const onClose = mock(() => {});
    const m = slashMenu({ items, onSelect, onClose });
    key(listbox(m), "ArrowDown");
    key(listbox(m), "Enter");
    expect(onSelect).toHaveBeenCalledWith(items[1]!, 1);
    key(listbox(m), "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("handled keys are consumed so the editor does not also act on them", () => {
    const m = slashMenu({ items });
    const e = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
    listbox(m).dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    const other = new KeyboardEvent("keydown", { key: "a", cancelable: true });
    listbox(m).dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  test("clicking a row selects it", () => {
    const onSelect = mock((_item: SlashMenuItem, _i: number) => {});
    const m = slashMenu({ items, onSelect });
    m.querySelectorAll<HTMLElement>('[role="option"]')[2]!.click();
    expect(onSelect).toHaveBeenCalledWith(items[2]!, 2);
    expect(selected(m)).toBe(2);
  });

  test("each menu gets unique option ids", () => {
    const a = slashMenu({ items }).querySelector('[role="option"]')!.id;
    const b = slashMenu({ items }).querySelector('[role="option"]')!.id;
    expect(a).not.toBe(b);
  });
});

describe("syncStatus", () => {
  test.each([
    ["local", 0, "Saved on this device"],
    ["offline", 0, "Offline · saved on this device"],
    ["syncing", 1, "Syncing 1 change"],
    ["syncing", 3, "Syncing 3 changes"],
    ["synced", 1, "Synced · 1 peer"],
    ["synced", 2, "Synced · 2 peers"],
  ] as const)("%s with %d reads %p", (state, count, text) => {
    expect(syncText({ state, count })).toBe(text);
  });

  test("is a status region, and offline is styled exactly like every other state (§2)", () => {
    const states: SyncState[] = ["local", "offline", "syncing", "synced"];
    const nodes = states.map((state) => syncStatus({ state, count: 2 }));
    for (const n of nodes) expect(n.getAttribute("role")).toBe("status");
    expect(new Set(nodes.map((n) => n.className)).size).toBe(1);
  });
});
