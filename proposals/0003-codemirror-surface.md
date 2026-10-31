# Proposal 0003: the writing surface — ProseMirror, CodeMirror within

**Status: OPEN — 7-day comment period (GOVERNANCE). Opened: 2026-10-31.**
Amends DM-9's surface seam on ratification. Records the CodeMirror
counter-analysis that informed the decision.

## Decision

Adopt **ProseMirror** as the reference editor's writing surface at the
DM-9 seam — a projection, never the authority (§1) — and embed
**CodeMirror 6 inside code-block node views** for real language editing.

## Why ProseMirror

1. **The document is a tree; ProseMirror's model is a tree.** nooq's
   forest (sections with children, subtree moves, placement register)
   maps to PM nodes at near-identity — the projection DM-9 defines is
   structural alignment, not translation. The alternative (encoding a
   forest into a flat line sequence) makes every structural op a line-
   range rewrite, fakes nesting, and splits selection across coordinate
   systems.
2. **Existence proofs.** Every Yjs block editor in the wild worth
   naming is ProseMirror + y-prosemirror. y-prosemirror (MIT) was built
   for exactly our layout — `Y.Map` blocks, `Y.Array` order, `Y.Text`
   inline, which DM-9 specified independently — and its relative
   positions are SW-7's block-anchored carets. We adapt a proven
   binding rather than invent a flat-tree encoding.
3. **Writers-first semantics.** Cross-block selection, marks, IME,
   node views for non-text blocks: PM's maturity is concentrated
   exactly where a writing editor lives.

## The CodeMirror analysis (why it lost, kept honestly)

CodeMirror 6 was seriously considered — an earlier draft of this
proposal adopted it. Its real strengths:

- **Splices.** CM6 changes are position splices; DM-4.3's TextChange
  steps are splices; the local mapping is clean. But PM's ReplaceStep
  is also a splice, so this is a coordinate-transform comparison, not a
  data-model win.
- **Everything is an extension**, rhyming with §7 — aesthetic, not
  structural; PM has plugins too.
- **It stays, inverted.** The industry recipe for code blocks in PM is
  an embedded CM6 instance. nooq's code blocks get real language modes
  as node views — CM6 joins the stack where it is unmatched.

Why it lost: a flat line-sequence core against a forest document; block
widgets (its least-proven API) doing the job of PM node views (its
most-proven); no existence proof of a tree block editor on CM6.

## Landmine, named

BlockNote is MPL-2.0. Read for understanding, copy nothing — file-level
copyleft is the asterisk nooq exists to reject. The dependency surface
is ProseMirror (MIT), y-prosemirror patterns (MIT), CM6 (MIT): the
Covenant stays clean.

## Binding contract (what implements on ratification)

1. Local PM transactions → per-block DM-4.3 splices → `Editor.apply`
   (§1: one keystroke = one splice transaction, as the textarea seam
   proved; PM transactions batch into nooq transactions per update).
2. Remote admitted envelopes → projection change → PM transaction whose
   step maps carry selection: EB-7.1 at the surface by construction.
3. Presence anchors `{block, offset}` (SW-7) ↔ PM relative positions;
   remote carets as PM decorations via @nooq/design presence chips.
4. Non-text blocks (suggestions, embeds) are node views over the same
   @nooq/design components — never text.
5. Structure changes (move/delete/split) enter as nooq ops; the PM doc
   is re-derived from the projection. The schema is generated from the
   block registry (§7: every block equal, built-in or not).

## Spike scope (pre-ratification, lands separately)

Both directions at state level: typing → splices → transactions;
remote splice → PM steps with selection mapping; presence anchor →
decoration position. The textarea surface remains until graduation;
EB-5/6/7 measure the seam before it ships.
