# nooq Design Philosophy

nooq's design philosophy is derived from four stances taken at founding:

1. **Framework first.** nooq is a framework with opinions, not a component
   with props.
2. **Local-first as architecture.** CRDT-native from the first commit, not
   collaboration bolted on later.
3. **AI as substrate.** AI manipulates document structure through the same
   protocol as humans — it is an actor, not a sidebar.
4. **Designed for the people writing in it.** The design loop is the
   writing experience, not the integrator's dashboard.

### Resolving the obvious tension

"Framework first" and "writers first" conflict only if the framework is
designed in a vacuum. nooq resolves this the way the best frameworks
always have: **the framework is the product; the reference editor is the
proof.** nooq ships a first-party, open, deliberately boring reference
editor. Two rules bind it to the framework:

- Every capability the reference editor uses is a public framework
  capability. No private hooks, no internal-only APIs.
- Every pain a writer feels in the reference editor becomes a framework
  capability — never an app-level workaround.

The principles below are laws, not aspirations. Each carries a **Broken
when** test so it can be enforced in code review. If a change needs to
break a principle, the change is wrong — or the principle is, in which
case the document changes first, in public.

---

## 1. The document is the protocol

There is one document model and one transaction API. Every actor — a human
typing, an AI editing, an importer, an export pipeline, a sync peer —
commits changes through the same transactional interface. There are no
privileged callers.

- Commits us to: importers and AI emit transactions, never mutate render
  state; the public API is the *only* API, including inside nooq.
- Broken when: any feature works by reaching past the transaction layer.

## 2. Offline is the default state

A single-player document is a CRDT with one peer. The network is an
optimization, never a requirement. Servers — including nooq's own hosted
service, if it exists — are peers, not sources of truth.

- Commits us to: every feature functioning in airplane mode from the first
  commit; sync as a background concern the writer never waits on.
- Broken when: any input, save, or edit blocks on connectivity, or any
  feature gates on round-trips.

## 3. The cursor is sacred

Writers feel latency in their fingertips. Keystroke-to-paint must fit in
one frame. Typing is never queued behind sync, AI generation, or
re-rendering; every interaction is optimistic.

- Commits us to: performance budgets enforced in CI (input-to-paint ≤ one
  frame; reference-document benchmarks tracked per release), not aspired
  to in issue comments.
- Broken when: a benchmark regresses silently, or typing visibly waits on
  anything.

## 4. Structure is addressable; identity is stable

Every block has a stable identity from the moment it exists. References —
comments, links, AI suggestions, anchors — point to block identities,
never to indexes or positions. Copy-paste between documents is a merge,
because CRDT physics says it is.

- Commits us to: identity that survives reorder, move, replication, and
  merge; positions are always derived, never stored as truth.
- Broken when: any feature breaks because content moved.

## 5. Provenance is part of the document

Every transaction carries an actor: a human, an AI, an importer, a peer.
What changed, and who or what changed it, is queryable for the document's
entire life. AI edits are **proposals by default** — diffable, reviewable,
attributable, revertable. Human review of machine edits is a first-class
flow, not an afterthought.

- Commits us to: attribution stored in the document, not in logs;
  suggestion and acceptance as document-level operations.
- Broken when: an AI edit lands indistinguishably from a human's, or
  provenance is only knowable while the logs survive.

## 6. Intelligence is pluggable; the contract is not

nooq defines the *document manipulation contract* — the tools, transactions,
and provenance schema an intelligent actor uses. Models are plugins. Bring
your own. The framework ships zero dependence on any first-party model or
model vendor, consistent with the Covenant.

- Commits us to: the reference editor's AI features working against any
  conforming model; no API that only one vendor's model can call.
- Broken when: a nooq feature requires a specific model, account, or
  hosted endpoint to function.

## 7. Everything is a block, including the built-ins

Every built-in block — paragraph, heading, image, AI suggestion — is
implemented as a plugin against the same public extension API nooq offers
everyone. Opinionated defaults, no hardcoded magic.

- Commits us to: shipping built-ins as ordinary plugins in the repo;
  an extension can override any built-in by the same mechanism.
- Broken when: a built-in has a code path a third-party block cannot have.

## 8. Boring core, adventurous edges

The core — schema, identity, transaction semantics, CRDT behavior —
changes slowly, with semver discipline and CRDT-aware migrations, because
documents must live for decades. Experimentation happens in blocks and
plugins, where failure is cheap and nothing is load-bearing.

- Commits us to: schema changes ship with migration paths for existing
  documents; experiments never fork the core.
- Broken when: opening a six-month-old document fails, or an experiment
  requires a core fork.

## 9. Accessibility is a writer, not a checklist

A writer using a screen reader, keyboard-only navigation, or an
alternative input device is a first-class writer, tested as early as the
mouse-and-GUI writer.

- Commits us to: keyboard-complete editing; accessibility testing in the
  reference editor's CI, not a remediation phase.
- Broken when: any editing task requires a pointer, or a11y bugs wait
  behind feature work.

---

## What this document is for

In code review, in API debates, and in roadmap calls: principles are
citable by number. "This PR violates §2" is a complete argument. If the
principle is wrong, change the document first — in public, under the
governance process — and then change the code.
