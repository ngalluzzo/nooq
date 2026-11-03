/**
 * Markdown import (Tier-2, gap audit #5): the export engine's inverse — a
 * pure text → blocks parser for exactly the reference surface's own dialect
 * (headings, the three list kinds with nesting, quotes, dividers, paragraphs,
 * and the inline marks strong/em/code/link-with-payload per 0009). What the
 * editor exports, it can now paste back: the round trip
 * export → import → export is the identity over supported documents, and
 * that property is pinned by test.
 *
 * Unknown syntax degrades to paragraph text — visible, never dropped, and
 * never a failed paste.
 */
import { newBlockId, type Block, type RenderedText } from "@nooq/core";

/** A parsed block: its data (children empty — ids come from insertion) and
 *  its parsed children, nested. The import command walks this tree. */
export interface ImportedBlock { data: Block; children: ImportedBlock[] }

/** One parsed line: the block kind and its content, with nesting depth. */
interface ParsedLine { depth: number; block: Block }

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const CHECK = /^[-*]\s\[( |x|X)\]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const DIVIDER = /^(?:---+|===+|\*\*\*+)$/;

/**
 * Inline markdown → RenderedText: strong/em/code and [label](url) links.
 * Links mint a `link:<id>` token per distinct URL and record the payload in
 * the block's fields (0009 §2: the mark says linked, the field says where).
 */
function parseInline(raw: string): { text: RenderedText; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const linkIds = new Map<string, string>();
  let s = "";
  const marks: string[][] = [];
  let i = 0;
  const push = (text: string, set: string[]): void => { s += text; for (let k = 0; k < text.length; k++) marks.push(set); };
  // One pass, leftmost-first; nested same-glyph spans are rare in pastes and
  // degrade honestly to text.
  while (i < raw.length) {
    const rest = raw.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\*\*([^*]+)\*\*/)) !== null) { push(m[1]!, ["strong"]); i += m[0]!.length; continue; }
    if ((m = rest.match(/^\*([^*]+)\*/)  ) !== null) { push(m[1]!, ["em"]); i += m[0]!.length; continue; }
    if ((m = rest.match(/^`([^`]+)`/)    ) !== null) { push(m[1]!, ["code"]); i += m[0]!.length; continue; }
    if ((m = rest.match(/^\[([^\]]*)\]\(([^)\s]+)\)/)) !== null) {
      const url = m[2]!;
      let token = linkIds.get(url);
      if (token === undefined) { token = `link:${newBlockId().slice(0, 6)}`; linkIds.set(url, token); fields[token] = url; }
      push(m[1]!, [token]);
      i += m[0]!.length;
      continue;
    }
    // A literal character: any opener that did not match is text.
    push(raw[i]!, []);
    i += 1;
  }
  return { text: { s, marks }, fields };
}

const textBlock = (type: string, content: string, fields: Record<string, unknown> = {}): Block => {
  const inline = parseInline(content);
  const block: Block = {
    id: newBlockId(), type,
    fields: { ...fields, ...inline.fields } as Block["fields"],
    text: inline.text,
    children: [],
    attribution: { created: { actor: "" }, fields: {} },
  };
  return block;
};

/** Measure one line's markdown indentation in list-nesting units (2 spaces). */
const depthOf = (line: string): { depth: number; rest: string } => {
  const spaces = line.match(/^ */)?.[0]?.length ?? 0;
  return { depth: Math.floor(spaces / 2), rest: line.slice(spaces) };
};

/**
 * Parse markdown text into nooq blocks: the reference dialect, the export
 * engine's exact inverse. Pure — no editor, no DOM, no ids from the outside.
 */
export function importMarkdown(markdown: string): ImportedBlock[] {
  const lines = markdown.split(/\r?\n/);
  const roots: ImportedBlock[] = [];
  // The stack's last entry is the deepest open list item; paragraphs close it.
  const stack: ImportedBlock[][] = [roots];
  const listDepth: number[] = [-1];
  let pendingBlank = false;

  for (let lineAt = 0; lineAt < lines.length; lineAt++) {
    const original = lines[lineAt]!;
    if (original.trim() === "") { pendingBlank = true; continue; }
    // Tables (plugin-tables, 0015): consecutive pipe rows, separators skipped.
    if (/^\|.*\|$/.test(original.trim())) {
      const rowLines: string[] = [];
      let scan = lineAt;
      for (; scan < lines.length; scan++) {
        const candidate = depthOf(lines[scan]!).rest.trim();
        if (!/^\|.*\|$/.test(candidate)) break;
        if (!/^\|[\s:|-]+\|$/.test(candidate)) rowLines.push(candidate); // skip separators
      }
      lineAt = scan - 1;
      if (rowLines.length > 0) {
        const tableNode: Block = { id: newBlockId(), type: "nooq.table/v1", fields: {} as Block["fields"], children: [], attribution: { created: { actor: "" }, fields: {} } };
        const tableItem: ImportedBlock = { data: tableNode, children: [] };
        for (const rowLine of rowLines) {
          const cells = rowLine.slice(1, -1).split("|").map(cell => cell.trim());
          const rowNode: Block = { id: newBlockId(), type: "nooq.table-row/v1", fields: {} as Block["fields"], children: [], attribution: { created: { actor: "" }, fields: {} } };
          const rowItem: ImportedBlock = { data: rowNode, children: [] };
          for (const cellText of cells) {
            const cellNode: Block = { id: newBlockId(), type: "nooq.table-cell/v1", fields: {} as Block["fields"], text: { s: cellText, marks: cellText.split("").map(() => []) }, children: [], attribution: { created: { actor: "" }, fields: {} } };
            rowItem.children.push({ data: cellNode, children: [] });
          }
          tableItem.children.push(rowItem);
        }
        stack.length = 1; listDepth.length = 1;
        roots.push(tableItem);
        pendingBlank = false;
        continue;
      }
    }
    // Display math (plugin-math): $$ opens and closes, the LaTeX verbatim.
    if (original.trim() === "$$") {
      const body: string[] = [];
      lineAt++;
      for (; lineAt < lines.length && lines[lineAt]!.trim() !== "$$"; lineAt++) body.push(lines[lineAt]!);
      const mathNode: Block = {
        id: newBlockId(), type: "nooq.math/v1",
        fields: {} as Block["fields"],
        text: { s: body.join("\n"), marks: body.join("\n").split("").map(() => []) },
        children: [],
        attribution: { created: { actor: "" }, fields: {} },
      };
      stack.length = 1; listDepth.length = 1; // a fence closes every open list
      roots.push({ data: mathNode, children: [] });
      pendingBlank = false;
      continue;
    }
    // Fenced code (plugin-code): ```lang opens, the body is verbatim until
    // the closing fence — never re-interpreted as markdown.
    if (original.startsWith("```")) {
      const lang = original.slice(3).trim();
      // ```mermaid is a DIAGRAM (plugin-diagram), not code — the fence's
      // info string routes it, the source rides verbatim either way.
      if (lang.toLowerCase() === "mermaid") {
        const body: string[] = [];
        lineAt++;
        for (; lineAt < lines.length && !lines[lineAt]!.startsWith("```"); lineAt++) body.push(lines[lineAt]!);
        const diagramNode: Block = {
          id: newBlockId(), type: "nooq.diagram/v1",
          fields: {} as Block["fields"],
          text: { s: body.join("\n"), marks: body.join("\n").split("").map(() => []) },
          children: [],
          attribution: { created: { actor: "" }, fields: {} },
        };
        stack.length = 1; listDepth.length = 1;
        roots.push({ data: diagramNode, children: [] });
        pendingBlank = false;
        continue;
      }
      const body: string[] = [];
      lineAt++;
      for (; lineAt < lines.length && !lines[lineAt]!.startsWith("```"); lineAt++) body.push(lines[lineAt]!);
      stack.length = 1; listDepth.length = 1; // a fence closes every open list
      const codeNode: Block = {
        id: newBlockId(), type: "nooq.code/v1",
        fields: { lang: lang === "" ? "text" : lang } as Block["fields"],
        // One mark slot per character (the model's invariant) — code has none.
        text: { s: body.join("\n"), marks: body.join("\n").split("").map(() => []) },
        children: [],
        attribution: { created: { actor: "" }, fields: {} },
      };
      roots.push({ data: codeNode, children: [] });
      pendingBlank = false;
      continue;
    }
    const { depth, rest } = depthOf(original);
    let parsed: ParsedLine | null = null;
    let isList = false;

    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/)) !== null) {
      // An image (plugin-image): ![alt](src) — the caption is the text limb.
      const imgNode: Block = {
        id: newBlockId(), type: "nooq.image/v1",
        fields: { src: m[2]!, ...(m[1] !== undefined && m[1] !== "" ? { alt: m[1]! } : {}) } as Block["fields"],
        text: { s: m[1] ?? "", marks: (m[1] ?? "").split("").map(() => []) },
        children: [],
        attribution: { created: { actor: "" }, fields: {} },
      };
      stack.length = 1; listDepth.length = 1;
      roots.push({ data: imgNode, children: [] });
      pendingBlank = false;
      continue;
    }
    if (DIVIDER.test(rest)) parsed = { depth, block: { id: newBlockId(), type: "nooq.divider/v1", fields: {}, children: [], attribution: { created: { actor: "" }, fields: {} } } as Block };
    else if ((m = rest.match(HEADING)) !== null) parsed = { depth, block: textBlock("nooq.heading/v1", m[2]!, { level: m[1]!.length }) };
    else if ((m = rest.match(CHECK)) !== null) { isList = true; parsed = { depth, block: textBlock("nooq.list/v1", m[2]!, { kind: "check", ...(m[1] !== " " ? { checked: true } : {}) }) }; }
    else if ((m = rest.match(BULLET)) !== null) { isList = true; parsed = { depth, block: textBlock("nooq.list/v1", m[1]!, { kind: "bullet" }) }; }
    else if ((m = rest.match(NUMBERED)) !== null) { isList = true; parsed = { depth, block: textBlock("nooq.list/v1", m[1]!, { kind: "number" }) }; }
    else if ((m = rest.match(QUOTE)) !== null) parsed = { depth, block: textBlock("nooq.quote/v1", m[1]!) };
    else parsed = { depth, block: textBlock("nooq.paragraph/v1", rest) };

    const item: ImportedBlock = { data: parsed.block, children: [] };
    if (!isList) {
      // Non-list blocks close every open list: back to the roots.
      stack.length = 1; listDepth.length = 1;
      roots.push(item);
      pendingBlank = false;
      continue;
    }

    // A list item: nest under the last list item at depth-1.
    while (listDepth.length > 1 && depth <= listDepth[listDepth.length - 1]!) { stack.pop(); listDepth.pop(); }
    const container = stack[stack.length - 1]!;
    container.push(item);
    stack.push(item.children);
    listDepth.push(depth);
    pendingBlank = false;
  }
  return roots;
}
