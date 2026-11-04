# nooq vs BlockNote gap audit

**Updated November 4, 2026.** This compares the current nooq checkout with
BlockNote’s documented features, including its optional XL packages. Shipped
means implemented in the repo and usable in an editor composition. The ranking
follows a writer moving an existing document into nooq, editing it, and sharing
it for review. The order is an estimate based on that workflow.

**Status.** nooq covers most everyday block editing. The most noticeable gaps
are collaboration-aware undo/redo across all edits, richer clipboard support,
threaded comments, and document export. nooq already has signed authorship, document-level access control, and
AI proposals that revalidate as the document changes.

## What shipped

| Area | What works in nooq today |
|---|---|
| Writing and rearranging | Nested bullets, numbered lists, and checklists. Headings support H1–H6, with H1–H3 in the slash menu. Dividers, quotes, links, basic inline marks, a formatting toolbar, and drag or keyboard block movement are implemented. Document-wide text selection is available as a surface option. [Writing commands](../packages/plugins/src/essentials.ts) · [Drag handle](../packages/plugin-draghandle/src/index.ts) · [Surface options](../packages/editor/src/dom.ts) |
| Code, math, diagrams, and images | CodeMirror syntax highlighting, KaTeX equations, rendered diagrams, and image blocks are available as plugins. Images support URLs and host-provided upload. The sync package implements content-addressed blob storage and verifies bytes on fetch. [Block showcase](../packages/design/stories/KitchenSink.stories.ts) · [Image host hooks](../packages/plugin-image/src/dom.ts) · [Blob store](../packages/sync/src/blob-store.ts) |
| Tables and columns | Tables have row and column operations, header rows and columns, column resizing, merged cells, cell colors, cell ranges, TSV paste, and Markdown import/export. Concurrent structural edits can produce short rows, which the table shows and lets users complete. The slash menu inserts two equal columns. Resizing a gutter and placing blocks beside each other support up to three columns, with narrow layouts stacking in reading order. [Tables](../packages/design/stories/Tables.stories.ts) · [Two columns](../packages/design/stories/TwoColumns.stories.ts) |
| Markdown | Markdown import, Markdown-aware paste, and export to clipboard or download are implemented. Markdown flattens columns. [Paste path](../packages/editor/src/dom.ts) · [Export formatters](../packages/plugins/src/export.ts) · [Export dialog](../packages/editor/src/export-ui.ts) |
| Rich paste | Clipboard HTML from Word, Google Docs, and the web imports paragraphs, headings, nested lists, links, and inline marks. Each paste is one edit. Undo restores replaced formatting while preserving nearby edits from peers. [HTML decoder](../packages/editor/src/html-paste.ts) · [Paste tests](../packages/editor/test/rich-paste.test.ts) |
| Collaboration and review | Local edits, Yjs sync, presence, per-block history, signed attribution, grants and revocation, and verified checkpoints are implemented. Writers can accept or reject AI proposals, and peers revalidate proposals after edits. The reference story uses an in-memory relay and the reference rewrite uses a simulated provider. Hosts supply production storage, transport, and the model client. [Whole Product story](../packages/design/stories/WholeProduct.stories.ts) · [Sync protocol](../SYNC.md) · [Reference rewrite](../packages/editor/src/reference.ts) |

Both editors support Yjs collaboration, custom blocks, and AI suggestion review.
BlockNote provides React UI components and also supports vanilla JavaScript.
nooq’s DOM surface composes feature plugins directly and its source is Apache-2.0.
BlockNote’s AI integration, advanced columns, and PDF/DOCX/ODT exporters are XL
packages available under GPL-3.0 or a commercial license. Tables are part of
BlockNote’s standard block set. [BlockNote setup](https://www.blocknotejs.org/docs/getting-started/editor-setup) · [Collaboration](https://www.blocknotejs.org/docs/features/collaboration) · [Tables](https://www.blocknotejs.org/docs/features/blocks/tables) · [XL licensing](https://www.blocknotejs.org/legal/blocknote-xl-commercial-license) · [nooq license](../LICENSE)

## Remaining gaps, in order of user impact

| Rank | Gap | When a writer notices it |
|---|---|---|
| 1 | **Collaboration-aware undo/redo across edits** | When undoing an earlier edit after a teammate changes the same document. nooq anchors rich paste undo to the affected content. Extending that behavior to ordinary typing and other commands remains a gap. [Paste undo](../packages/editor/src/paste-undo.ts) · [BlockNote undo/redo](https://www.blocknotejs.org/docs/reference/editor/overview#undoredo) |
| 2 | **Clipboard fidelity and HTML import** | When copying a table, inline image, or layout from a rich source, pasting between nooq documents with custom blocks, or importing standalone HTML. [BlockNote paste handling](https://www.blocknotejs.org/docs/reference/editor/paste-handling) |
| 3 | **Threaded comments** | The first time someone wants to leave feedback on a passage without editing it. nooq has presence, history, and proposal review. BlockNote also has anchored comment threads, replies, and resolution. [BlockNote comments](https://www.blocknotejs.org/docs/features/collaboration/comments) |
| 4 | **HTML and document export** | The first handoff to a browser, email, a PDF reader, or a Word workflow. nooq’s export UI offers Markdown. BlockNote supports HTML import and export in the standard library and PDF, DOCX, and ODT export through XL packages. [BlockNote formats](https://www.blocknotejs.org/docs/foundations/supported-formats) |
| 5 | **Formatting and block breadth** | When styling a report, folding a long section, or attaching media. BlockNote offers text and background colors, alignment, toggle headings and lists, and file, audio, and video blocks. [BlockNote built-in blocks](https://www.blocknotejs.org/docs/features/blocks) |
| 6 | **Ready-to-integrate AI writing** | When asking the editor to write, rewrite, or format with a real model. nooq has streaming preview and proposal review through a provider hook. The reference uses a simulator and the general model adapter is drafted. BlockNote offers a model integration and writing commands in its XL AI preview. [nooq model proposal](../proposals/0008-bring-your-own-model.md) · [BlockNote AI](https://www.blocknotejs.org/docs/features/ai) |
| 7 | **Layouts with more than three columns** | When laying out four or more items across a wide document. nooq supports up to three columns with variable widths and side placement. [nooq layout story](../packages/design/stories/TwoColumns.stories.ts) · [BlockNote multi-column example](https://www.blocknotejs.org/examples/basic/multi-column) |
| 8 | **Localized editor UI** | At first open for writers who need a non-English interface. nooq’s reference strings are English. BlockNote ships locale dictionaries and lets hosts override strings. [BlockNote localization](https://www.blocknotejs.org/docs/features/localization) |

Native IME is a separate acceptance check. nooq tests composition events, while
native cross-block composition still needs verification. For writers who rely on
an IME, that check belongs with first-use editing. [Plugin authoring proposal](../proposals/0004-plugin-authoring-v2.md)

The Whole Product, Tables, and Two Columns stories passed in light and dark.
The reference editor also has CI gates for load time, typing latency, and
caret stability during remote edits. [Experience budgets](../EXPERIENCE-BUDGETS.md) · [Lab workflow](../.github/workflows/lab.yml)
