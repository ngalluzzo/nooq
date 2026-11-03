import { expect, test } from "bun:test";
import { emptyDocument, makeBlock, type Block, type DocState, type RenderedText } from "@nooq/core";
import { exportMarkdown, markdownText, quoteLines, referenceFormatters, type BlockFormatter } from "../src/index.ts";

/** RenderedText from [text, marks] runs; sets are sorted and deduped as the model stores them. */
function rt(runs: readonly (readonly [string, readonly string[]])[]): RenderedText {
  const s = runs.map(([text]) => text).join("");
  const marks: string[][] = [];
  for (const [text, set] of runs) for (const _ of text) marks.push([...new Set(set)].sort());
  return { s, marks };
}

/** Builds a document by placing blocks with explicit parents (null = root). */
class Builder {
  readonly state: DocState = emptyDocument("export");
  add(block: Block, parent: string | null = null): Block {
    this.state.blocks[block.id] = block;
    if (parent === null) this.state.roots.push(block.id);
    else this.state.blocks[parent]!.children.push(block.id);
    return block;
  }
}
const inline = (id: string, type: string, text: RenderedText, fields?: Block["fields"]): Block =>
  makeBlock({ id, type, text, ...(fields ? { fields } : {}) }, "writer");

test("every reference block type renders: title, heading per level, paragraph, quote per line", () => {
  const doc = new Builder();
  doc.add(inline("t", "nooq.title/v1", rt([["Q3 field notes", []]])));
  doc.add(inline("h2", "nooq.heading/v1", rt([["Section", []]]), { level: 2 }));
  doc.add(inline("h3", "nooq.heading/v1", rt([["Subsection", []]]), { level: 3 }));
  doc.add(inline("p", "nooq.paragraph/v1", rt([["hello world", []]])));
  doc.add(inline("q", "nooq.quote/v1", rt([["first line", []], ["\nsecond line", []]])));
  const result = exportMarkdown(doc.state);
  expect(result.markdown).toBe("# Q3 field notes\n\n## Section\n\n### Subsection\n\nhello world\n\n> first line\n> second line");
  expect(result.pending).toBe(0);
  expect(result.skippedUnknown).toBe(0);
});

test("an absent or invalid heading level renders as the reference h2 default", () => {
  for (const fields of [undefined, { level: 0 }, { level: -1 }, { level: 2.5 }, { level: "2" }]) {
    const doc = new Builder();
    doc.add(inline("h", "nooq.heading/v1", rt([["Title", []]]), fields));
    expect(exportMarkdown(doc.state).markdown).toBe("## Title");
  }
});

test("children nest after their parent, inside the parent's form", () => {
  const doc = new Builder();
  const section = doc.add(inline("h", "nooq.heading/v1", rt([["Section", []]]), { level: 2 }));
  doc.add(inline("c1", "nooq.paragraph/v1", rt([["first child", []]])), section.id);
  const quote = doc.add(inline("q", "nooq.quote/v1", rt([["quoted", []]])));
  doc.add(inline("c2", "nooq.paragraph/v1", rt([["child of quote", []]])), quote.id);
  const root = doc.add(inline("r", "nooq.paragraph/v1", rt([["root", []]])));
  doc.add(inline("gc", "nooq.paragraph/v1", rt([["grandchild", []]])), root.children[0]!);
  expect(exportMarkdown(doc.state).markdown).toBe([
    "## Section\n\nfirst child",
    "> quoted\n>\n> child of quote",
    "root\n\ngrandchild",
  ].join("\n\n"));
});

test("markdownText renders every mark, combinations nesting to ***, and runs separately", () => {
  expect(markdownText(rt([["bold", ["strong"]]]))).toBe("**bold**");
  expect(markdownText(rt([["it", ["em"]]]))).toBe("*it*");
  expect(markdownText(rt([["x = 1", ["code"]]]))).toBe("`x = 1`");
  expect(markdownText(rt([["both", ["em", "strong"]]]))).toBe("***both***");
  expect(markdownText(rt([["all", ["code", "em", "strong"]]]))).toBe("***`all`***");
  expect(markdownText(rt([["plain", []], ["bold", ["strong"]], ["plain", []]]))).toBe("plain**bold**plain");
  expect(markdownText(rt([["unknown", ["acme.flair"]]]))).toBe("unknown"); // §8: unknown marks degrade to plain
  expect(markdownText(rt([["mixed", ["acme.flair", "strong"]]]))).toBe("**mixed**");
  expect(markdownText(undefined)).toBe("");
  expect(markdownText(rt([["", []]]))).toBe("");
});

test("link tokens resolve their payload from fields by the full token, wrapped outermost", () => {
  const fields: Record<string, unknown> = { "link:9f2c": "https://nooq.dev" };
  expect(markdownText(rt([["nooq", ["link:9f2c"]]]), fields)).toBe("[nooq](https://nooq.dev)");
  expect(markdownText(rt([["nooq", ["link:9f2c", "strong"]]]), fields)).toBe("[**nooq**](https://nooq.dev)");
});

test("a payloadless link token degrades to plain text", () => {
  expect(markdownText(rt([["dangling", ["link:gone"]]]), { "link:other": "https://nooq.dev" })).toBe("dangling");
  expect(markdownText(rt([["no fields", ["link:gone"]]]))).toBe("no fields");
  expect(markdownText(rt([["not a string", ["link:obj"]]]), { "link:obj": { href: "https://nooq.dev" } })).toBe("not a string");
});

test("when the model carries two link tokens, the smallest wins deterministically", () => {
  const fields: Record<string, unknown> = { "link:a": "https://a.dev", "link:b": "https://b.dev" };
  expect(markdownText(rt([["t", ["link:b", "link:a"]]]), fields)).toBe("[t](https://a.dev)");
  expect(markdownText(rt([["t", ["link:a", "link:b"]]]), fields)).toBe("[t](https://a.dev)");
});

test("live suggestions are excluded and counted pending, nested ones included in the count", () => {
  const doc = new Builder();
  doc.add(makeBlock({ id: "s1", type: "nooq.suggestion/v1", fields: { proposal: { base: { rootDigest: "x" }, ops: [], evidence: [], context: null } } }, "ai:1"));
  doc.add(inline("p", "nooq.paragraph/v1", rt([["kept", []]])));
  const outer = doc.add(makeBlock({ id: "s2", type: "nooq.suggestion/v1", fields: { proposal: { base: { rootDigest: "y" }, ops: [], evidence: [], context: null } } }, "ai:1"));
  doc.add(makeBlock({ id: "s3", type: "nooq.suggestion/v1", fields: { proposal: { base: { rootDigest: "z" }, ops: [], evidence: [], context: null } } }, "ai:1"), outer.id);
  doc.add(inline("c", "nooq.paragraph/v1", rt([["child of a suggestion leaves with it", []]])), outer.id);
  const result = exportMarkdown(doc.state);
  expect(result.markdown).toBe("kept");
  expect(result.pending).toBe(3); // the wrapper swallows its subtree, but every pending proposal is counted
  expect(result.skippedUnknown).toBe(0);
});

test("tombstoned blocks are absent from the markdown and never count", () => {
  const doc = new Builder();
  doc.add(inline("t", "nooq.title/v1", rt([["Doc", []]])));
  doc.add(inline("p", "nooq.paragraph/v1", rt([["live", []]])));
  // Tombstones (DM-3.4): present in `blocks`, absent from roots/children.
  doc.state.blocks["dead-suggestion"] = makeBlock({ id: "dead-suggestion", type: "nooq.suggestion/v1", fields: { status: "accepted" } }, "ai:1");
  doc.state.blocks["dead-paragraph"] = inline("dead-paragraph", "nooq.paragraph/v1", rt([["deleted", []]]));
  doc.state.blocks["dead-unknown"] = makeBlock({ id: "dead-unknown", type: "acme.box/v1" }, "writer");
  const result = exportMarkdown(doc.state);
  expect(result.markdown).toBe("# Doc\n\nlive");
  expect(result.pending).toBe(0);
  expect(result.skippedUnknown).toBe(0);
});

test("unknown inline-text types fall back to the plain paragraph form (§8), not dropped, not counted", () => {
  const doc = new Builder();
  const note = doc.add(inline("n", "acme.note/v1", rt([["foreign text", []]])));
  doc.add(inline("c", "nooq.paragraph/v1", rt([["child still exports", []]])), note.id);
  const result = exportMarkdown(doc.state);
  expect(result.markdown).toBe("foreign text\n\nchild still exports");
  expect(result.skippedUnknown).toBe(0);
});

test("unknown text:none types are skipped and counted; their known children still export in place", () => {
  const doc = new Builder();
  doc.add(inline("t", "nooq.title/v1", rt([["Doc", []]])));
  const box = doc.add(makeBlock({ id: "b", type: "acme.box/v1" }, "writer"));
  doc.add(inline("c", "nooq.paragraph/v1", rt([["inside the box", []]])), box.id);
  doc.add(inline("p", "nooq.paragraph/v1", rt([["after", []]])));
  const result = exportMarkdown(doc.state);
  expect(result.markdown).toBe("# Doc\n\ninside the box\n\nafter");
  expect(result.skippedUnknown).toBe(1);
});

test("option formatters take precedence per type and can override or extend the reference set", () => {
  const doc = new Builder();
  doc.add(inline("p", "nooq.paragraph/v1", rt([["plain", []]])));
  doc.add(inline("n", "acme.note/v1", rt([["note", []]])));
  const loud: BlockFormatter = block => `NOTE: ${JSON.stringify(block.fields)}`;
  const result = exportMarkdown(doc.state, { formatters: { "nooq.paragraph/v1": () => "[paragraph]", "acme.note/v1": loud } });
  expect(result.markdown).toBe("[paragraph]\n\nNOTE: {}");
});

test("a host formatter can choose to include suggestions; only exclusions count as pending", () => {
  const doc = new Builder();
  doc.add(makeBlock({ id: "s", type: "nooq.suggestion/v1", fields: { proposal: { base: { rootDigest: "x" }, ops: [], evidence: [], context: null } } }, "ai:1"));
  const include: BlockFormatter = block => `> suggestion from ${JSON.stringify(block.fields.proposal)}`;
  expect(exportMarkdown(doc.state, { formatters: { "nooq.suggestion/v1": include } })).toEqual({ markdown: expect.stringContaining("> suggestion"), pending: 0, skippedUnknown: 0 });
  expect(exportMarkdown(doc.state, { formatters: { "nooq.suggestion/v1": include } }).markdown).toBe(exportMarkdown(doc.state, { formatters: { "nooq.suggestion/v1": include } }).markdown);
});

test("the same state always exports the same markdown", () => {
  const doc = new Builder();
  doc.add(inline("t", "nooq.title/v1", rt([["Doc", []]])));
  const quote = doc.add(inline("q", "nooq.quote/v1", rt([["quoted", []], ["text", ["strong"]]])));
  doc.add(inline("c", "nooq.paragraph/v1", rt([["child", []]])), quote.id);
  doc.add(inline("d", "nooq.paragraph/v1", rt([["link me", ["link:1a"]]]), { "link:1a": "https://nooq.dev" }));
  doc.add(makeBlock({ id: "s", type: "nooq.suggestion/v1", fields: { proposal: { base: { rootDigest: "x" }, ops: [], evidence: [], context: null } } }, "ai:1"));
  doc.state.blocks["box"] = makeBlock({ id: "box", type: "acme.box/v1" }, "writer"); // tombstoned: never counted
  const first = exportMarkdown(doc.state);
  expect(exportMarkdown(doc.state)).toEqual(first);
  expect(exportMarkdown(structuredClone(doc.state))).toEqual(first); // block-map key order is not load-bearing
  expect(first).toEqual({
    markdown: "# Doc\n\n> quoted**text**\n>\n> child\n\n[link me](https://nooq.dev)",
    pending: 1,
    skippedUnknown: 0,
  });
});

test("an empty document exports as empty markdown", () => {
  expect(exportMarkdown(emptyDocument("empty"))).toEqual({ markdown: "", pending: 0, skippedUnknown: 0 });
});

test("quoteLines prefixes every line and keeps blank separators as bare >", () => {
  expect(quoteLines("one\ntwo")).toBe("> one\n> two");
  expect(quoteLines("body\n\nchild")).toBe("> body\n>\n> child");
  expect(quoteLines("")).toBe("");
});

test("a two-column document exports left-then-right in tree order, no skips", () => {
  const doc = new Builder();
  doc.add(inline("t", "nooq.title/v1", rt([["Q3 plan", []]])));
  const columns = doc.add(makeBlock({ id: "cols", type: "nooq.columns/v1" }, "writer"));
  const left = doc.add(makeBlock({ id: "col-l", type: "nooq.column/v1" }, "writer"), columns.id);
  doc.add(inline("l1", "nooq.paragraph/v1", rt([["left column first", []]])), left.id);
  const right = doc.add(makeBlock({ id: "col-r", type: "nooq.column/v1" }, "writer"), columns.id);
  doc.add(inline("r1", "nooq.paragraph/v1", rt([["right column second", []]])), right.id);
  doc.add(inline("p", "nooq.paragraph/v1", rt([["after the columns", []]])));
  const result = exportMarkdown(doc.state);
  // Reading order is the rule (foundation.md): tree order = column order, so
  // the left column's content precedes the right's, layout wrappers add
  // nothing, and nothing counts as skipped or pending.
  expect(result.markdown).toBe("# Q3 plan\n\nleft column first\n\nright column second\n\nafter the columns");
  expect(result.pending).toBe(0);
  expect(result.skippedUnknown).toBe(0);
});

test("an empty columns block contributes nothing and never counts", () => {
  const doc = new Builder();
  const columns = doc.add(makeBlock({ id: "cols", type: "nooq.columns/v1" }, "writer"));
  const left = doc.add(makeBlock({ id: "col-l", type: "nooq.column/v1" }, "writer"), columns.id);
  const right = doc.add(makeBlock({ id: "col-r", type: "nooq.column/v1" }, "writer"), columns.id);
  doc.add(inline("only", "nooq.paragraph/v1", rt([["the one live child", []]])), left.id);
  const result = exportMarkdown(doc.state);
  expect(result.markdown).toBe("the one live child");
  expect(result.pending).toBe(0);
  expect(result.skippedUnknown).toBe(0);
});

test("reference formatters are keyed by the reference block types", () => {
  expect(Object.keys(referenceFormatters).sort()).toEqual([
    "nooq.column/v1", "nooq.columns/v1", "nooq.divider/v1", "nooq.heading/v1", "nooq.list/v1", "nooq.paragraph/v1", "nooq.quote/v1", "nooq.suggestion/v1", "nooq.title/v1",
  ]);
  expect(Object.isFrozen(referenceFormatters)).toBe(true);
});

