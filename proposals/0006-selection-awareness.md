# Proposal 0006: selections in awareness

**Status: DRAFT — not yet opened. Drafted: 2026-11-01. Decision of record:
none yet.** Covers SYNC Draft 3.3 (SW-7). No DOCUMENT-MODEL change: DM-8
already names selection as awareness. The spec text lands with this
proposal; maintainers ratify or amend in the comment period.

The change is additive and keeps wire v1, so it may qualify as routine
under GOVERNANCE. It is filed as a proposal because it changes a
normative wire section, and SW-11 asks for the doc before the code.
The reference implementation was spiked first and is uncommitted; this
text lands before it.

## Problem

DM-8 says "presence, cursors, and selection are ephemeral awareness".
SW-7 carries only a caret, `{block, offset}`. A collaborator's selection
is what a writer most needs to see before editing the same words, and it
has no wire form.

The spike found three more gaps on the receiving side:

| Finding | Evidence |
| --- | --- |
| The reference surface never announced its own cursor. Presence worked end to end in tests but stayed dark in the editor. | No caller of `Editor.setCursor` outside tests. |
| Offsets are absolute. Rendering them as received paints the wrong characters once anyone edits ahead of them, until the sender moves. A sender whose editor is not focused never moves. | Chrome, two writers: a selection slid six characters after the other writer typed "Look: " in front of it. |
| A cursor can arrive before the text it points into. Relays and peers verify signed updates asynchronously (SW-6) and forward awareness at once, so ordering at the sender does not survive the trip. | Burst test: the cursor reached the peer while its text was still verifying. |

## Change

SW-7, Draft 3.3:

```json
"cursor": { "block": "<blockId>", "offset": 0,
            "anchor": { "block": "<blockId>", "offset": 0 } } | null
```

1. **`anchor`, optional.** The fixed end of a selection that is not
   collapsed. `block`/`offset` stays the caret, the moving end. This
   matches the DOM's anchor and focus and the plugin API's
   `DocumentTextSelection { anchor, head }`. Senders SHOULD omit
   `anchor` for a collapsed caret. Receivers MUST treat an `anchor`
   equal to the caret as collapsed.
2. **Selections may span blocks.** A selection covers the live text
   blocks between its ends in document preorder, which is the order the
   local document selection already uses.
3. **Awareness is unauthenticated input.** Receivers MUST ignore unknown
   fields of `cursor`. They MUST drop a malformed `anchor` (one that is
   not an object with a string `block` and a non-negative integer
   `offset`) and keep the caret. A malformed caret drops the whole
   cursor.
4. **Receivers map held cursors.** Receivers SHOULD map a held cursor
   through every text change they apply after receiving it, by the rule
   that keeps the local selection on its characters (EB-7, DM-4). The
   sender's next announcement replaces the mapping.
5. **An offset can be ahead of the receiver.** An offset past the end of
   the receiver's text means the sender holds text the receiver has not
   yet admitted. Receivers SHOULD hold it unmapped, clamped for display,
   until that text arrives.
6. **When senders announce.** Senders SHOULD announce on every selection
   change. While a typing burst is open (DM-14.3), a sender MAY hold the
   caret and announce it when the burst seals, so peers get one cursor
   per burst rather than one per keystroke.

## Compatibility

- **Older receivers** draw the caret and never read `anchor`. The
  reference receiver matched on `cursor.block` alone.
- **Older senders** never send `anchor`, so newer receivers draw a caret.
- **Relays** need no change. The reference relay forwards awareness
  frames as received; SW-6 says nothing about awareness.
- **No wire version bump.** SW-2 forbids unknown `v` and `t`, but says
  nothing about unknown fields in a known type. Item 3 closes that gap
  for `cursor` only (see Open questions).

## Rendering (informative)

The reference editor paints remote selections with the CSS Custom
Highlight API: one registered highlight per peer ink, holding
`StaticRange`s that are rebuilt each frame. Carets and name flags sit in
an overlay. Neither writes into text hosts, so presence cannot disturb
the local caret, composition or input path (PHILOSOPHY §3). Text owned
by plugins paints without being touched. Other renderers are free to
differ; nothing here is normative.

## Privacy

A selection reveals a little more than a caret: what a writer is looking
at. It travels on the same channel to the same audience, peers who can
already read the document. SW-9 is unchanged.

## Non-goals

- Multiple ranges per actor (multi-cursor).
- Selecting a block as a whole rather than its text, such as an embed or
  an image.
- Signed awareness. Any peer can still claim any actor's cursor. That is
  tolerable only because awareness never reaches document state (SW-7).
- Awareness piggybacking on `update` (SW-10.3).

## Tests that will gate this

`packages/editor/test/presence.test.ts`:

- An anchor crosses the wire.
- A remote selection becomes one highlight per ink over block text. No
  markup is written into text hosts, and a surface removes only the
  ranges it added.
- Held cursors stay on their characters through later local edits, and
  an offset that is ahead waits until its text lands.
- A malformed anchor is dropped and the caret kept; a negative offset is
  ignored.
- Without the Highlight API the caret still renders.
- The surface announces its writer's selection and skips repeats.

`packages/editor/test/bursts.test.ts`:

- A caret held in an open burst goes out when the burst seals, and a
  selection goes out at once.

`packages/design/stories/Presence.stories.ts`:

- In a real browser, the registered highlight holds both segments of a
  selection that spans two blocks.

Not yet run: the EB-6 keystroke budget with peers present. The overlay
does no work without peers, but the cost with peers has not been
measured.

## Open questions

1. **Generalize the unknown-fields rule?** Should SW-2 require receivers
   to ignore unknown fields in every known message type, so the next
   additive field needs no section-level rule?
2. **Offset unit.** DM-4 counts "characters" without naming a unit. The
   reference implementation and the plugin API use UTF-16 code units, so
   a peer counting code points would put carets in the wrong place after
   an astral character. Pin it in DM-4?
3. **Expiry is not implemented.** SW-7 says receivers SHOULD expire
   entries after about 60s. The reference editor keeps them until the
   peer sends `null`. Selections make a stale entry more visible.

## Amendments during the comment period

None yet.
