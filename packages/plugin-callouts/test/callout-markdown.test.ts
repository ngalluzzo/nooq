import { expect, test } from "bun:test";
import { exportMarkdown, type Block, type DocState, type JsonValue, type RenderedText } from "@nooq/plugins";
import { callout, calloutMarkdown } from "../src/index.ts";

/** plugin-callouts depends only on @nooq/plugins, so the test builds model values by hand. */
function rt(runs: readonly (readonly [string, readonly string[]])[]): RenderedText {
  const s = runs.map(([text]) => text).join("");
  const marks: string[][] = [];
  for (const [text, set] of runs) for (const _ of text) marks.push([...new Set(set)].sort());
  return { s, marks };
}

function block(id: string, type: string, text?: RenderedText, fields?: Record<string, JsonValue>): Block {
  return { id, type, fields: { ...(fields ?? {}) }, ...(text ? { text } : {}), children: [],
    attribution: { created: { actor: "writer" }, fields: {} } };
}

function calloutDoc(text: RenderedText, tone?: unknown, child?: Block): DocState {
  const state: DocState = { docId: "callouts", schemaVersion: 1, roots: [], blocks: {} };
  const parent = block("c", callout.type, text, tone === undefined ? undefined : { tone: tone as JsonValue });
  state.blocks[parent.id] = parent;
  state.roots.push(parent.id);
  if (child) {
    state.blocks[child.id] = child;
    parent.children.push(child.id);
  }
  return state;
}

const exportCallout = (state: DocState) => exportMarkdown(state, { formatters: { [callout.type]: calloutMarkdown } });

test("each tone maps to its GitHub alert marker", () => {
  expect(exportCallout(calloutDoc(rt([["Mind the gap", []]]), "info")).markdown).toBe("> [!NOTE]\n> Mind the gap");
  expect(exportCallout(calloutDoc(rt([["Careful now", []]]), "warning")).markdown).toBe("> [!WARNING]\n> Careful now");
  expect(exportCallout(calloutDoc(rt([["It worked", []]]), "success")).markdown).toBe("> [!TIP]\n> It worked");
});

test("an unfamiliar or absent tone degrades to [!NOTE]", () => {
  expect(exportCallout(calloutDoc(rt([["x", []]]), "critical")).markdown).toBe("> [!NOTE]\n> x");
  expect(exportCallout(calloutDoc(rt([["x", []]]))).markdown).toBe("> [!NOTE]\n> x");
  expect(exportCallout(calloutDoc(rt([["x", []]]), 3)).markdown).toBe("> [!NOTE]\n> x");
});

test("multi-line callout text quotes every line; marks render inside the body", () => {
  const state = calloutDoc(rt([["line one\nline ", []], ["two", ["strong"]]]), "info");
  expect(exportCallout(state).markdown).toBe("> [!NOTE]\n> line one\n> line **two**");
});

test("children export after the text, inside the same alert", () => {
  const child = block("k", "nooq.paragraph/v1", rt([["child paragraph", []]]));
  const state = calloutDoc(rt([["body", []]]), "warning", child);
  expect(exportCallout(state).markdown).toBe("> [!WARNING]\n> body\n>\n> child paragraph");
});

test("an empty callout exports its marker alone, and determinism holds", () => {
  const state = calloutDoc(rt([["", []]]), "success");
  const first = exportCallout(state);
  expect(first).toEqual({ markdown: "> [!TIP]", pending: 0, skippedUnknown: 0 });
  expect(exportCallout(structuredClone(state))).toEqual(first);
});
