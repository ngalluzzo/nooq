/**
 * Markdown export engine (foundation P2): a pure DocState → markdown
 * projection with no DOM, no editor, and no registry. The walk covers the
 * live tree only, in liveTree order (roots, then each block's children
 * recursively); DM-3.4 tombstones are absent from parents' children lists,
 * so they never export and never count. Block outputs join with blank
 * lines. Content is never silently dropped (§8): unknown inline-text types
 * degrade to the plain paragraph form, and unknown text:"none" blocks are
 * skipped but counted in `skippedUnknown`.
 */
import { liveTree, SUGGESTION_TYPE } from "@nooq/core";
import type { Block, BlockId, DocState, RenderedText } from "@nooq/core";
import type { Immutable } from "./definitions.ts";

/**
 * The helpers a block formatter receives besides the block itself: its
 * inline text rendered to markdown and its children already exported.
 */
export interface FormatterContext {
  /**
   * The block's RenderedText with every mark rendered (see `markdownText`):
   * `**`/`*`/`` ` `` styles, links resolved from the block's fields by the
   * full token. "" when the block has no inline text.
   */
  text(): string;
  /**
   * The block's live children already exported to markdown and joined with
   * blank lines — children render first (depth-first), the formatter only
   * places them. "" when there are no live children.
   */
  readonly children: string;
}

/**
 * Renders one block to markdown. Receives the immutable block plus the
 * `FormatterContext` helpers. Returns the block's markdown, or `undefined`
 * to exclude the block and its subtree from the export.
 */
export type BlockFormatter = (block: Immutable<Block>, context: FormatterContext) => string | undefined;

/** Export options: formatters keyed by block type. They take precedence over the reference set, per type. */
export interface ExportMarkdownOptions {
  formatters?: Readonly<Record<string, BlockFormatter>>;
}

/** The export result: the markdown plus what the walk excluded or skipped. */
export interface MarkdownExport {
  markdown: string;
  /**
   * Live nooq.suggestion/v1 blocks excluded by their formatter — proposals
   * still awaiting review are not content (DM-6). Tombstoned suggestions
   * are never walked and never count.
   */
  pending: number;
  /** Live blocks with no formatter and no inline text (unknown text:"none" types) that were skipped. */
  skippedUnknown: number;
}

/**
 * Render RenderedText to markdown — the text half of every formatter.
 * Runs of characters with the same mark set wrap together: `strong` → `**`,
 * `em` → `*`, `code` → `` ` `` (combinations nest, so strong+em is `***`),
 * and `link:<id>` tokens resolve their payload from `fields[token]` to
 * `[text](href)` — the link wraps outermost, around any styles. A link
 * token without a usable string payload degrades to plain text, and so do
 * unknown marks (§8: preserved in the document, unwrapped here). Call it
 * without `fields` and every link degrades the same way.
 */
export function markdownText(text: Immutable<RenderedText> | undefined, fields?: Readonly<Record<string, unknown>>): string {
  if (!text || text.s.length === 0) return "";
  const parts: string[] = [];
  let set: string[] | undefined, signature = "", from = 0;
  const flush = (to: number): void => { if (set) parts.push(applyMarks(text.s.slice(from, to), set, fields)); };
  for (let at = 0; at < text.s.length; at++) {
    // The model stores marks sorted and unique; normalize defensively so the
    // run signature is the set's identity either way.
    const current = [...new Set(text.marks[at] ?? [])].filter(Boolean).sort();
    const next = current.join("\u0000");
    if (set !== undefined && next === signature) continue;
    flush(at);
    set = current; signature = next; from = at;
  }
  flush(text.s.length);
  return parts.join("");
}

/** Wrap one run, innermost out: code, em, strong, then the link outermost. */
function applyMarks(content: string, marks: readonly string[], fields?: Readonly<Record<string, unknown>>): string {
  let out = content;
  // Code innermost: a code span nested inside emphasis keeps its glyphs and
  // still carries them (`***`x`***`), while code outside would swallow them.
  if (marks.includes("code")) out = `\`${out}\``;
  if (marks.includes("em")) out = `*${out}*`;
  if (marks.includes("strong")) out = `**${out}**`; // strong outside em: strong+em nests to ***
  if (marks.includes("strike")) out = `~~${out}~~`; // GFM strikethrough
  // Underline and highlight have no markdown: CommonMark's inline HTML
  // carries them verbatim (what the writer meant survives the round trip).
  if (marks.includes("underline")) out = `<u>${out}</u>`;
  if (marks.includes("highlight")) out = `<mark>${out}</mark>`;
  // 0009: hosts enforce one token per base per character on apply, the model
  // may tolerate more, and readers pick deterministically — smallest wins.
  const token = marks.filter(mark => mark.startsWith("link:")).sort()[0];
  if (token !== undefined) {
    const href = fields?.[token];
    // Payloadless (or non-string) links degrade to plain text — visible, never dropped.
    if (typeof href === "string") out = `[${out}](${href})`;
  }
  return out;
}

/** Prefix every line with `> `; empty lines become a bare `>` (blockquote continuation). Empty content stays empty. */
export function quoteLines(content: string): string {
  if (content === "") return "";
  return content.split("\n").map(line => line ? `> ${line}` : ">").join("\n");
}

/** The block's own output followed by its children after a blank line; nothing to add when there are none. */
function withChildren(own: string, children: string): string {
  return children ? `${own}\n\n${children}` : own;
}

/** `# ` — the document's single title (one per document is convention, §7). */
export const titleFormatter: BlockFormatter = (block, { text, children }) => withChildren(`# ${text()}`, children);

/**
 * `##` per level: `fields.level` decides the number of `#`s. The reference
 * surface presents a heading as h2, so an absent or invalid level is 2;
 * levels are not clamped — the stored field decides.
 */
export const headingFormatter: BlockFormatter = (block, { text, children }) => {
  const level = block.fields.level;
  const depth = typeof level === "number" && Number.isInteger(level) && level > 0 ? level : 2;
  return withChildren(`${"#".repeat(depth)} ${text()}`, children);
};

/** The divider: `---`, children after a blank line (Tier-1). */
export const dividerFormatter: BlockFormatter = (block, { children }) => withChildren("---", children);

/** Plain: the rendered text, children after a blank line. Also the §8 fallback for unknown inline-text types. */
export const paragraphFormatter: BlockFormatter = (block, { text, children }) => withChildren(text(), children);

/** `> ` prefixed per line; children join the same blockquote after a blank quoted line. */
export const quoteFormatter: BlockFormatter = (block, { text, children }) =>
  quoteLines([text(), children].filter(part => part.length > 0).join("\n\n"));

/** The proposal wrapper is not content (DM-6): excluded — `undefined` — and counted pending by the engine. */
export const suggestionFormatter: BlockFormatter = () => undefined;

/**
 * Layout passthrough (foundation P2): the columns block adds nothing of its
 * own, so its children export in place — column 1 then column 2, the same
 * tree order the surface lays them out in (reading order = column order =
 * DOM order, foundation.md). A known layout block is known, never
 * `skippedUnknown`.
 */
export const columnsFormatter: BlockFormatter = (_block, { children }) => children;

/** One column, the same passthrough; the pair exports left-then-right in tree order. */
export const columnFormatter: BlockFormatter = (_block, { children }) => children;

/** Tier-1 list items: `- `, `1. `, `- [ ] `/`- [x] `; nesting indents the
 *  children (markdown's two-space rule) so import reconstructs the tree —
 *  the round trip's nesting limb. */
export const listFormatter: BlockFormatter = (block, { text, children }) => {
  const kind = String(block.fields.kind ?? "bullet");
  const prefix = kind === "number" ? "1. " : kind === "check" ? (block.fields.checked === true ? "- [x] " : "- [ ] ") : "- ";
  const indented = children ? children.split("\n").map(line => line.trim() === "" ? line : `  ${line}`).join("\n") : "";
  return withChildren(`${prefix}${text()}`, indented);
};

/** The reference formatters, keyed by block type; the base every export starts from. */
export const referenceFormatters: Readonly<Record<string, BlockFormatter>> = Object.freeze({
  "nooq.title/v1": titleFormatter,
  "nooq.heading/v1": headingFormatter,
  "nooq.paragraph/v1": paragraphFormatter,
  "nooq.quote/v1": quoteFormatter,
  "nooq.list/v1": listFormatter,
  "nooq.divider/v1": dividerFormatter,
  "nooq.columns/v1": columnsFormatter,
  "nooq.column/v1": columnFormatter,
  [SUGGESTION_TYPE]: suggestionFormatter,
});

/**
 * Export the live tree of a document to markdown. Pure: the state is read
 * (accepts a mutable DocState or a frozen snapshot) and never modified, so
 * the same state always exports the same markdown. Malformed states
 * (multi-parent blocks, missing children entries) throw, as `liveTree` does.
 */
export function exportMarkdown(state: Immutable<DocState>, options: ExportMarkdownOptions = {}): MarkdownExport {
  liveTree(state as DocState); // validate the walk: DM-3.1 violations and dangling children throw here
  const counts = { pending: 0, skippedUnknown: 0 };
  const renderChildren = (ids: readonly BlockId[]): string => {
    const parts: string[] = [];
    for (const id of ids) {
      const rendered = renderBlock(state.blocks[id]!);
      if (rendered) parts.push(rendered);
    }
    return parts.join("\n\n");
  };
  const renderBlock = (block: Immutable<Block>): string | undefined => {
    // Children render first (liveTree's depth-first order); the formatter places them.
    const children = renderChildren(block.children);
    const context: FormatterContext = { text: () => markdownText(block.text, block.fields), children };
    const formatter = options.formatters?.[block.type] ?? referenceFormatters[block.type];
    if (formatter !== undefined) {
      const own = formatter(block, context);
      if (own === undefined && block.type === SUGGESTION_TYPE) counts.pending++;
      return own;
    }
    if (block.text !== undefined) return paragraphFormatter(block, context); // §8: inline content degrades to the plain form
    counts.skippedUnknown++; // unknown text:"none": the block itself cannot be represented…
    return children === "" ? undefined : children; // …but its known children still export in place
  };
  return { markdown: renderChildren(state.roots), ...counts };
}
