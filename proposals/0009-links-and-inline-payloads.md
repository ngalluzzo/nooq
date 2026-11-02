# Proposal 0009: links and inline payloads

**Status: ACCEPTED — direction of record, locked 2026-11-01. Decision of record: issue #10 (retroactive).** Covers an
amendment to the plugin API (text policies gain a mark grammar and renderer
contributions; `@nooq/plugins` gains one recipe) and one reserved mark. **No
DOCUMENT-MODEL change and no digest change — that is the point of the design.**
Implementation lands together with this document.

Links need a payload: a mark says *this text is a link*, but something must
carry *where to*. The same is true of every future inline semantic a plugin
might ship (mentions, term definitions, comment anchors). This proposal
decides the mechanism once, for built-ins and plugins alike, and ships links
as its first consumer — implemented through the same contribution path a
plugin author would use, so plugin parity cannot rot (§7: if a built-in
needs a style a plugin could not use, the style is wrong).

## Problem

| Finding | Evidence |
| --- | --- |
| Marks are bare per-character strings; there is nowhere to put an href. | `RenderedText`, `packages/core/src/model.ts`; DM-3.3 |
| Whatever carries the payload must live inside `fields` or `marks`, or the content digest goes blind to it. | DM-6.1: the content digest covers `{type, fields, textDigest}` with `textDigest` over canonical `{s, marks}` |
| Structured marks would change what `{s, marks}` fingerprints, so old and new peers would compute different digests over the same stored document — breaking every proposal's evidence across the bump. | DM-6.1; DM-3.3 |
| The policy validator admits exactly three marks and throws on anything else. | `packages/plugins/src/text-policy.ts`: "Invalid text policy marks" |
| The rich host renders a fixed schema plus one generic unknown span; plugins cannot present their own marks. | `packages/editor/src/rich-text.ts` (PM schema, `opaque` mark) |
| Unknown formatting is already preserved and shown (dotted, named) — but only as a degradation, never as data a renderer can use. | §8 handling, `rich-text.ts` |

## Change

### 1. The convention: token marks, payload in fields

A **payloaded mark** is two halves joined by one grammar:

- the **token** in the marks arrays: `<base>:<id>` — the base is the
  semantic, the id is data. `link:9f2c1a` says "linked"; `9f2c1a` says which
  link. Ids come from the same generator and discipline as block ids.
- the **payload** in the block's fields, keyed by the full token:
  `fields["link:9f2c1a"] = "https://nooq.dev"` (any JSON value in general).

Why fields: DM-3.2 makes each key a last-writer-wins register, so two
writers adding *different* links to one block merge cleanly (per-key LWW, not
a wholesale table clobber). Why tokens: DM-3.3 already attaches formatting to
characters, so a link rides the sequence CRDT with no range bookkeeping.

**Invariants.** At most one token per base per character (host-enforced on
apply; the model tolerates more and renderers pick deterministically). A
payloaded base never appears bare in stored marks — `link` alone is not a
legal token. Orphaned field entries (payload whose token was overwritten)
are tolerated: **garbage collection is a non-goal, on the DM-3.4 precedent** —
bounded, invisible, cleaned whenever the document is rebased.

**Atomicity.** Applying a payloaded mark is one transaction: a `textEdit` op
setting the token over the range plus a `setField` op writing the payload.
Partial states arise only from concurrency and degrade honestly: a token
without a payload renders as the §8 unknown mark — visible, preserved.

### 2. The mark grammar: reserved and namespaced bases

Policy `marks` lists become lists of **bases**; a stored mark matches a
policy by its base (split on the first `:`).

- **Bare bases are reserved for nooq:** `strong`, `em`, `code`, and now
  `link`.
- **Plugin bases are namespaced by the declaring plugin's id**, mirroring
  block-type naming (`acme.callout/v2`): a plugin `acme.mentions` may
  declare the base `acme.mentions`, or `acme.mentions.note` for several.
  `defineDOMPlugin` enforces the prefix and rejects poaching another
  plugin's namespace or a reserved bare name.

Two plugins cannot collide on `mention` for the same reason two block types
cannot collide on `callout`.

### 3. Mark renderers: a policy contribution

`defineTextPolicy` grows an optional `renderMarks`, keyed by base:

```ts
renderMarks?: Record<string, (payload: JsonValue | undefined, text: string) => Node>;
```

The **host resolves the payload** from the block's fields by the shared
convention and hands `(payload, text)` to the plugin's renderer; the rich
surface builds its mark schema per-surface from the contributions. A host
without the plugin keeps the universal fallback: the §8 dotted underline,
named. As a courtesy of the convention, that fallback's title resolves a
token with a sibling field entry — "Link: https://nooq.dev" instead of raw
`link:9f2c1a` — so even a foreign host shows the meaning.

### 4. The recipe: `markWithPayload`

`@nooq/plugins` ships the atomic transaction as a recipe, in the
`cycleFieldCommand` tradition: build the token (fresh id), set it over the
selection, write the payload, one command, one intent. Removal clears the
token and leaves the field (GC non-goal).

### 5. Links: the first consumer, dogfooded

Links go through exactly the path a plugin would: the reserved base `link`,
payload `href: string`, applied by a `nooq.text.link` command built on
`markWithPayload` in essentials, rendered by a renderer contribution
(an `<a>` in `ink`), admitted by the reference policy.

The writer-facing surface is keyboard-first (§9), avoiding the still-open
selection-toolbar appearance question: select text, **Mod-k**, a popover
carrying one text field for the href — Enter applies, Esc returns focus and
changes nothing. The formatting-toolbar P1 consumes the same command later.

## What deliberately does not change

- **No DM change.** Tokens are marks; payloads are fields; both are existing
  first-class storage.
- **No digest change.** Both halves sit inside the content digest already;
  changing a link's href changes the content digest, so proposals made
  against linked text drift-detect correctly. (This is the acceptance test —
  see below.)
- **No CRDT or codec change.** `setMarks` carries tokens as strings; fields
  entries are fields entries.

## Compatibility

| Situation | Behavior |
| --- | --- |
| Old host receives a token mark | §8 dotted unknown, named, preserved (title resolves the href when the field entry exists) |
| Old host receives the field entry | Unfamiliar field, preserved (existing schema discipline) |
| Old host edits text around a link | Marks are per-character; the token rides |
| Old host overwrites the span's marks | The token goes, as any formatting decision does; the field entry orphans silently |
| New host reads an old document | No tokens, no entries; nothing to do |
| Two writers link the same characters | Per-character marks resolve as today; per-key fields resolve by LWW |

## Acceptance

1. **Digest continuity:** editing a link's href changes the content digest
   and drifts a proposal whose evidence covered the linked text.
2. **Foreign-host roundtrip:** a peer without link support relays a document
   with links; tokens and payloads survive byte-identically.
3. **Grammar:** `defineDOMPlugin` rejects a bare reserved base and a
   namespace poach; policies match tokens by base.
4. **Atomicity:** `nooq.text.link` produces exactly one transaction carrying
   both ops.
5. **Keyboard:** Mod-k opens the popover on the selection, Enter applies,
   Esc returns focus with no change — in both themes, with axe.
