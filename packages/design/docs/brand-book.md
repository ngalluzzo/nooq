nooq is a block-based rich-text editor framework: Notion-class editing, local-first collaboration, AI-assisted writing and export, all under one Apache-2.0 license. This system covers three surfaces: the project's own brand (site, docs, README art), the reference editor's writing surface, and the protocol-visible UI that only nooq has, where provenance, AI proposals and sync state become things a writer can see.

Every rule below cites the principle it serves. `§N` is a section of PHILOSOPHY.md; `DM-N` is a section of DOCUMENT-MODEL.md. "This violates §5" is a complete review comment here too.

## The idea: people write in ink, AI writes in pencil

Color in nooq means an actor. The document itself is graphite on paper; hue only appears where something says who did what.

- **`ink`** is the human hand. The local writer's caret, selection (`selection`), change bars and every accepted proposal use it.
- **`pencil`** is the AI hand, and nothing else (§5). An AI proposal is pencilled in: a `pencil-soft` wash with a dashed `pencil-text` underline. Accepting it inks it in: the text renders as ordinary document text, while the block's change bar stays dashed `pencil-text`, because AI text in a human's document is never unattributed (DM-5). Never use pencil for highlights, warnings or decoration; a writer must be able to trust that yellow means a machine proposed this.
- **`peer-*`** are the other humans in the document, six fountain-pen inks.
- **`machine`** is for importers, migrations and the system. Machines get no hue, only a word.
- **`stamp`** means structure broke: the conflicted state (DM-6.2) and destructive confirmations. Nothing else gets red.

## Visual foundations

### Color

- Ground the page on `paper`. Float menus, popovers and suggestion cards on `paper-raised` with `shadow-pop`. Use `paper-sunken` for wells: code, the slash menu's query, keyboard hints.
- Set all document text in `graphite`, secondary text in `graphite-muted`. Both read on every paper surface and every `-soft` wash in both themes.
- Separate with `rule`. Give every control edge `rule-strong`, which holds 3:1 against paper.
- Fills that carry text pair with their `on-` token: `ink-fill` with `on-ink`, `pencil` with `on-pencil`, `stamp` with `on-stamp`, a peer flag with `on-peer`. Never literal white.
- `pencil` is too light to read as text or as a thin bar on light paper. Strokes and text use `pencil-text`.
- In dark, `ink` lightens for text while `ink-fill` stays saturated for buttons. Use the one that matches the job.

### Peer inks are derived, not assigned

A remote writer's ink is a pure function of their actor ID, so every peer computes the same color with no coordination, the same way DM-6.2 derives suggestion state. Take the first 8 hex digits of `sha256(actorId)` as an integer, mod 6, and index into `peer-teal`, `peer-violet`, `peer-green`, `peer-sepia`, `peer-magenta`, `peer-slate` in that order. The local writer is always `ink` on their own screen. Two peers can land on the same ink; their name flags tell them apart, which is why a peer caret always carries a flag.

### Type

- Set document content in the Document styles (`doc-title`, `doc-h1`, `doc-h2`, `doc-body`, `doc-quote`), family `serif` (Literata). The writing surface is what nooq is designed around (founding stance 4), so it gets the reading face.
- Set all chrome in the Interface styles, family `sans` (Atkinson Hyperlegible Next). It was drawn for low-vision readers and keeps I, l and 1 apart (§9).
- Set anything a machine wrote and a person compares in the Data styles, family `mono` (Atkinson Hyperlegible Mono): digests, block ids, `nooq.paragraph/v1` type ids, ops. Use `digest` for inline fingerprints, `code` for code.
- `display` is the brand voice for site headlines and the wordmark. It never appears inside the editor.
- Keep the text column at `measure` (680px, about 70 characters of `doc-body`).
- Sentence case everywhere. Lowercase `nooq`, always, including at the start of a sentence.

### Space and layout

- Chrome spacing steps by 4px: `space-1` through `space-12`.
- The document keys off `doc-body`'s 30px line, not the 4px grid. Sibling blocks sit `block-gap` apart.
- Every block, built-in or third-party, sits right of a `gutter` (44px). The gutter holds the drag handle and the change bar, nothing else. The margin is where provenance lives (§5).
- A block's change bar is `change-bar` wide, runs the block's full height, and takes its last writer's color: `ink` for the local writer, its `peer-*` for a remote one, dashed `pencil-text` for AI, dotted `machine` for the rest.

### Radii, borders, shadows

- Blocks are rectangles. `radius-sm` for buttons, tags, digests; `radius-md` for cards and menus; `radius-xs` for change bars and name flags; `radius-full` for presence dots only.
- One shadow, `shadow-pop`, for things that float over the document. A suggestion docked in a side panel gets a `rule` outline instead.
- Never mark a card with a colored left border. State lives in the tag and the outline.

### State: three channels, always

Every state shows a word, a glyph and a fill, so nothing depends on color alone (§9). Suggestion states use their spec names verbatim, lowercase: fresh, stale, conflicted, accepted, rejected (DM-6.2).

| State | Word | Glyph | Fill |
| --- | --- | --- | --- |
| fresh | fresh | solid dot | `pencil` with `on-pencil` |
| stale | stale | half dot | dashed `pencil-text` outline, no fill |
| conflicted | conflicted | cross | `stamp` with `on-stamp` |
| accepted | accepted | check | `ink-soft` with `ink` |
| rejected | rejected | dash | `rule` outline, `graphite-muted` |

### Motion

- Nothing animates on the input path (§3). Keystroke-to-paint fits one frame, so no transition ever touches the caret, a block's text, or layout caused by typing.
- The caret blinks at 530ms on, 530ms off and stops blinking while the writer types. Under `prefers-reduced-motion` it does not blink.
- A suggestion's state changes in place the moment revalidation runs (DM-6.5). No toast, no flash. The tag and outline simply change.
- Menus and popovers may fade in over 80ms. That is the only animation in the editor.

### Focus

Every control shows `focus-ring` on keyboard focus: a 2px `paper` gap, then 2px of solid `ink`, drawn as a box-shadow so it follows the radius. Every editing task is keyboard-complete (§9): menus list their shortcuts and buttons a writer repeats show theirs.

### Sync

Offline is the default state (§2), not an error. Sync status is always `graphite-muted` text with a neutral glyph: "Saved on this device", "Syncing 3 changes", "Synced · 2 peers", "Offline · saved on this device". Never use `stamp` or `pencil` for connectivity, and never block input on it.

## Content fundamentals

nooq writes like its founding documents: plain, short, and citable. It states what it will and will not do, then stops.

- Say the thing. "Every feature. One license. Forever." Not "Unlock the full power of collaborative editing."
- Use the spec's nouns in the UI: suggestion, actor, block, digest. Use DM-6.2's state names exactly. The one translation: a tombstoned block is "deleted" to a writer (DM-3.4), with "Restore" as the action.
- Name actors. "Maya edited this paragraph after the proposal was made." Not "Content has changed."
- Every AI edit says which model. Every accepted one says who accepted it: "Proposed by qwen3-8b · accepted by Maya" (DM-5 adoption provenance).
- Explain drift in one sentence that names the cause: "The target block was deleted." "The paragraph was moved out of this section."
- No exclamation marks, no emoji, no "magic", no sparkles. AI is an actor, not a feature to celebrate.
- Cite sections as `§3` and `DM-6.2`, set in the text face, never linked as "learn more".
- Numbers a machine produced stay exact: lamport 42, not "a moment ago"; truncate digests as `sha256:9f2c1a…e81a` (first 6, last 4) and copy the full value.

## Iconography

nooq has no logo and no icon set yet. Set the name as plain type: lowercase `nooq` in `display`. Do not draw a mark until one is designed and added under Logos.

The components draw a small set of geometric glyphs inline as SVG in `currentColor`: the five state glyphs above, the six-dot drag handle, and the AI mark (a square hatched in `pencil-text` over `pencil`). Use typographic glyphs where a block type needs one in the slash menu (¶ for paragraph). No emoji, anywhere.

## Built-ins get nothing special (§7)

Every component here styles third-party blocks exactly as it styles built-ins: the same gutter, change bar, menu row and type id display. If a built-in needs a style a plugin could not use, the style is wrong. Integrators theme nooq by overriding these tokens, and the reference editor uses no value that is not a token.
