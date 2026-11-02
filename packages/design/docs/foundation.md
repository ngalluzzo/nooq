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
| Glyphs | The state glyphs, the drag handle, the AI mark, and the chrome set (close, more, chevron, undo, redo, history, access, verified, model, warning, stop, export) |
| Guarantees | Contrast promises tested in both themes; every story an axe and keyboard test in both themes; generated files checked in sync |

---

## P0: what plugin authors and hosts need now

All nine P0 areas from the first draft are built. What remains of them:

- **Missing tokens:** icon sizes and the hit-target minimum (control heights exist: `control-sm`, `control-md`, `control-handle`); find and comment highlights when they arrive (the remote-selection wash exists: `highlight-peer`). Motion (`fade`, `blink`) and layering (`layer-presence` through `layer-dialog`) are tokens — the logo timings stay with the logo in `brand/geometry.ts`.
- **Surfaces onto the popover:** the primitive exists (collision-aware, Esc-dismissible, focus returns, `tooltip` opens on keyboard focus); block history and link editing (Mod-k, 0009) sit on it. The slash menu and toolbar overflow still mount themselves and should move onto it.
- **Toolbar overflow and placement:** overflow into a menu (needs the popover) and the placement rule that never covers the caret's line (§3).
- **Notice beyond the error channel:** the editor surfaces view/plugin errors as one dismissable notice; authorization holds/denials and model errors still flow only through the toolbar's status line, and should use the notice's `hold`, `denial` and `model` kinds.

---

## P1: the protocol, visible to writers

All seven are built except the half blocked on the spec: lost moves wait on DM-10.

Built:

- **Job progress and draft preview.** The working state (who is working, which model, intent, Stop) and the draft preview — pencil text with no wash, explicitly not yet a proposal, replaced by the SuggestionCard on publish. Jobs surface through the Editor's `onJob`; `simulatedRewrite` streams its generation so the flow is real in-repo.
- **Block history.** The change bar is the door: a button with a hover-and-focus tooltip ("Last edited by …") opening the history popover — writer, intent as written, lamport exact ("lamport 42"), newest first — and tombstoned blocks draw the deleted BlockRow with Restore and later-edits counts instead of the generic fallback. Views can keep their own history presentation (`rendersHistory` on the view).
- **Presence roster.** Compact ink-dotted list beside the sync status; idle shows as a word. Idle is a local 5-minute recency heuristic — truthful idle wants a timestamp on the awareness wire, named below.
- **Announcer.** One shared, persistent, rate-limited live region (750ms, latest-wins): "X joined.", "X left.", "Suggestion is now stale." Never per keystroke.
- **Links and inline payloads (0009).** Marks are bases with tokens (`link:<id>`), payloads live in fields keyed by the full token, policies admit bases (reserved bare for nooq, namespaced for plugins, enforced at defineDOMPlugin), and views contribute renderers. Links are the dogfooded first consumer: `nooq.text.link` is one atomic transaction, anchors render in ink through the policy renderer, Mod-k opens the href popover on the selection, and foreign hosts preserve everything with the §8 dotted fallback. The mechanism is the plugin path — mentions, term definitions and comment anchors ship the same way.
- **Formatting toolbar.** The appearance policy is decided and shipped: POINTER selection only (a primary-button mouseup completing a non-collapsed selection in a rich host — never typing, never keyboard-only selection), dismissing on Escape, collapse or leave, placed above the selection and never over the caret's line. Buttons are exactly what the block's policy admits — the toggle trio plus Link (the same flow Mod-k opens); the strip is never a focus stop (§3, §9).
- **Access and signers, v1.** The header's Access button opens the access panel: roles from the replicated access header (self first, owner, grants — names joined from awareness, bare actorIds never invented), the verified glyph as "Their edits arrived verified here" (the honest weak form), and the permanent-grants footnote. The enabling wiring landed with it: `Editor.onAdmission` (mirrors the session's verdict payload verbatim — it carries no actor, a named sync-layer gap), `myRole()`/`accessState()`/`arrivedVerified()`, and denial/hold notices that preserve `retryable` with reasons verbatim; the local writer's remotely-refused envelope surfaces through the session's wire-error channel (`SessionError`, code `envelope-denied`). The stronger form — per-actor verdicts, held-envelope visibility, awareness-wire roles — is catalogued in `proposals/evidence/access-and-signers.md` as sync-layer work.
- **Away markers.** Built on the decided semantics: a remote change to a windowed-out block (the surface's rows map is the truth; detection arms after the first render, so opening a document marks nothing) notches its change bar — solid–gap–solid in the writer's own ink, never displacing the dashed AI or dotted machine pattern (DM-5) — with the screen-reader word "Changed while you were away". Exactly three clears: focus in the row, a local edit, opening the block's history. Session-local; scrolling never clears; deletion drops.

Still blocked on the spec:

- **Lost moves.** Until DM-10 resolves what a lost move observably is.

Named follow-ups from the landings: `Editor.close()` does not announce a local departure (only an explicit `setCursor(null)` does); the roster's self name falls back to the actor id until the Editor exposes a display name; true idle needs an awareness timestamp on the wire.

---

## P2: the reference app

Landed from the P2 passes:

- **Document header** — `documentHeader()` chrome (title slot leading, sync status, roster, actions slot, one rule below) composed by `createDocumentHeader` from `@nooq/editor`, host-mounted above the surface; the title binds to the new `nooq.title/v1` block, which the surface renders in the doc-title style with no special casing.
- **Shortcut sheet** — `shortcutSheet()` fed by `collectShortcuts(surface)`, which enumerates the LIVE resolved keymap, so the sheet cannot drift; "?" opens it (never while typing), Esc returns focus.
- **Dialog** — `dialog()` on the popover's focus discipline: viewport-centered, aria-modal, Tab trap, Esc and outside press are cancel semantics (a destructive action never fires implicitly), actions right-aligned with the primary last, destructive confirmations on the danger variant with verb labels. No backdrop in v1 (no scrim token); stories are the consumer of record until sharing/export arrive.
- **Loading** — `loading()`: nothing before 300ms (fast opens show nothing — that is the point), then the wordmark at loader timing looping while shown, at rest under reduced motion, `aria-busy` with the word. Wired into `createSurface` until first render + `editor.ready`; local documents are instant, so only remote bootstrap ever shows it. The windowed skeleton exists since the block-content work.
- **Export** — `exportMarkdown()` in `@nooq/plugins`: a pure function of document state, reference formatters for title/heading/paragraph/quote, marks nesting to markdown (links round-trip as `[text](href)` from 0009 payloads), suggestions excluded and counted pending, tombstones excluded, unknown inline-text blocks never silently dropped (§8). Plugin blocks export their own form through the formatters map — Callouts ships GitHub-alert syntax (`[!NOTE]`/`[!WARNING]`/`[!TIP]`). The UI: the header's opt-in Export button (the reference composition enables it; `createExportUI` is never access-gated) opens the dialog — format line, the pending count stated exactly and pluralized, Copy Markdown primary with the digest's graceful-refusal clipboard, Download as a feature-detected quiet action. Dialog's first real consumer.
- **Multi-column layout** — `nooq.columns/v1` over `nooq.column/v1`: mergeable structure as child blocks, not fields (DM-3.2). One `insert-columns` transaction from the slash menu (glyph `||`) consumes the slash and seeds both columns with an empty paragraph, the caret landing in column 1's; two writers in different columns merge cleanly because the columns are ordinary blocks in the tree. The views are plain elements — the surface's recursive walk nests them, and the theme's grid lays them out (the `column-gap` token; the nesting treatment resets inside columns because columns are parallel, not depth, while a column's own children keep the plain stacking; a max-width media query stacks one column on narrow widths, chosen over a container query because containment on `.nq-editor` would re-anchor its fixed-position popovers). READING ORDER is the rule: tree order = column order = DOM order, stacking on narrow widths degrades honestly to that same order, and export walks exactly it — both layout types pass their children through, never `skippedUnknown`.

---

## Definition of done for any foundation component

1. A function returning DOM, typed, exported from `@nooq/design`, with no framework dependency.
2. Every value from a token; no colors, sizes or durations in component CSS.
3. A story per state, run in both themes with axe and a keyboard play test.
4. Copy that follows the content fundamentals; state shown as word, glyph and fill.
5. A usage note saying what the consumer provides and when not to use it.
6. At least one real consumer in the repo (editor, a plugin, or the plugin agent's conformance check) before it's called done.
