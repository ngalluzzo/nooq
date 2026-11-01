# The foundation: what's built and what's left

The first version of this system styled nooq as it was imagined: a writing
surface, provenance in the margin, AI proposals as cards. nooq is now a
framework with a plugin API (proposals 0002 and 0004), signed access (0001),
a ProseMirror surface on the way (0003), history layers (0005), selections in
awareness (0006), an agent tool contract (0007) and bring-your-own-model jobs
(0008). Plugin authors and host apps now build UI on top of this system, and
where it has nothing to offer they improvise. This document lists what a
complete foundation needs so that they don't have to.

**What counts as foundation:** anything a plugin or host app needs to look and
behave like nooq without writing its own CSS, colors, spacing or interaction
logic. If two packages would build it twice, it belongs here.

**Priority:** P0 blocks others from building today. P1 is needed for the
protocol to be visible to writers. P2 completes the reference app.

---

## What exists

| Layer | Built |
| --- | --- |
| Tokens | Color (2 themes, 28 tokens), type (12 styles), spacing, radius, control sizes, highlight strengths, motion, layering, shadow, editor geometry; compiled to `--nq-*` with nestable themes, all inside one `@layer nq` |
| Brand | Wordmark, mark, app icon, the Move animation, self-hosted fonts with metric-matched fallbacks |
| Components | Button, ActorChip, Digest, StateTag, SuggestionCard, BlockRow, PresenceCaret, SlashMenu, SyncStatus, BlockContainer, Notice, Popover, Tooltip, form controls (text field, select, segmented, toggle, checkbox), presence roster, announcer, working state + draft preview, block history panel |
| Surface styles | `.nq-editor`, presence overlay with remote-selection highlights, document selection, generic fallback block, text hosts (plain and rich, pixel-identical apart from marks), block content (nesting, placeholders, windowed skeletons, list/code/divider), the block toolbar's visual contract |
| Protocol-visible UI | Job working state + draft preview (published → SuggestionCard), block history on an interactive change bar (lamport-exact, deleted-with-later-edits + Restore), presence roster, the shared announcer (joined/left/stale) |
| Plugin API surface | `blockContainer` re-exported from `@nooq/plugins/dom`; plugin-agent conformance fails a plugin that sets styles or colors directly |
| Glyphs | The state glyphs, the drag handle, the AI mark, and the chrome set (close, more, chevron, undo, redo, history, access, verified, model, warning, stop) |
| Guarantees | Contrast promises tested in both themes; every story an axe and keyboard test in both themes; generated files checked in sync |

---

## P0: what plugin authors and hosts need now

All nine P0 areas from the first draft are built. What remains of them:

- **Missing tokens:** icon sizes and the hit-target minimum (control heights exist: `control-sm`, `control-md`, `control-handle`); find and comment highlights when they arrive (the remote-selection wash exists: `highlight-peer`). Motion (`fade`, `blink`) and layering (`layer-presence` through `layer-dialog`) are tokens — the logo timings stay with the logo in `brand/geometry.ts`.
- **Surfaces onto the popover:** the primitive exists (collision-aware, Esc-dismissible, focus returns, `tooltip` opens on keyboard focus); the slash menu, toolbar overflow, link editing and block history still mount themselves and should move onto it.
- **Toolbar overflow and placement:** overflow into a menu (needs the popover) and the placement rule that never covers the caret's line (§3).
- **Notice beyond the error channel:** the editor surfaces view/plugin errors as one dismissable notice; authorization holds/denials and model errors still flow only through the toolbar's status line, and should use the notice's `hold`, `denial` and `model` kinds.

---

## P1: the protocol, visible to writers

Four of the seven are built; three still want decisions (or the spec) first.

Built:

- **Job progress and draft preview.** The working state (who is working, which model, intent, Stop) and the draft preview — pencil text with no wash, explicitly not yet a proposal, replaced by the SuggestionCard on publish. Jobs surface through the Editor's `onJob`; `simulatedRewrite` streams its generation so the flow is real in-repo.
- **Block history.** The change bar is the door: a button with a hover-and-focus tooltip ("Last edited by …") opening the history popover — writer, intent as written, lamport exact ("lamport 42"), newest first — and tombstoned blocks draw the deleted BlockRow with Restore and later-edits counts instead of the generic fallback. Views can keep their own history presentation (`rendersHistory` on the view).
- **Presence roster.** Compact ink-dotted list beside the sync status; idle shows as a word. Idle is a local 5-minute recency heuristic — truthful idle wants a timestamp on the awareness wire, named below.
- **Announcer.** One shared, persistent, rate-limited live region (750ms, latest-wins): "X joined.", "X left.", "Suggestion is now stale." Never per keystroke.

Still to decide or build:

- **Formatting toolbar.** Needs a links-in-the-text-model decision (marks are opaque strings today; a link needs a payload) and an appearance policy that respects §3. Built on Toolbar and Popover when decided.
- **Access and signers.** Waiting on a home (the document header is P2) and on what peer-verification state the sync layer exposes (DM-12, DM-13).
- **Away markers and lost moves.** The change-bar variant needs seen-state semantics; the lost-move notice is blocked until DM-10 resolves what a lost move observably is.

Named follow-ups from the landings: `Editor.close()` does not announce a local departure (only an explicit `setCursor(null)` does); the roster's self name falls back to the actor id until the Editor exposes a display name; true idle needs an awareness timestamp on the wire.

---

## P2: the reference app

- **Dialog,** for destructive confirmation, sharing, connecting a model and export. Built on Popover's focus handling.
- **Document header:** title, sync status, presence roster, share, history.
- **Shortcut sheet,** generated from registered actions and keymaps so it can't drift.
- **Export:** format choice and what to do with pending suggestions.
- **Multi-column layout block,** promised in the README and not yet designed.
- **Loading:** the logo loader only after 300ms, and the windowed skeleton.

---

## Definition of done for any foundation component

1. A function returning DOM, typed, exported from `@nooq/design`, with no framework dependency.
2. Every value from a token; no colors, sizes or durations in component CSS.
3. A story per state, run in both themes with axe and a keyboard play test.
4. Copy that follows the content fundamentals; state shown as word, glyph and fill.
5. A usage note saying what the consumer provides and when not to use it.
6. At least one real consumer in the repo (editor, a plugin, or the plugin agent's conformance check) before it's called done.
