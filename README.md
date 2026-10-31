# nooq

**Every feature. One license. Forever.**

nooq is a block-based rich-text editor. Notion-class editing UX, local-first
collaboration, AI-assisted writing, and document export — all of it in one
Apache-2.0 licensed core, with no paid tier that unlocks features.

This file is the founding document. It is meant to be boring: it states what
nooq will never do, so that future debates can end by pointing at a line.

---

## Why nooq exists

In 2026, "open source" editors follow a familiar script:

- The homepage says **"100% open source."**
- The core is liberally licensed (MPL-2.0, MIT).
- The features that actually define modern editing — **AI integration,
  export to PDF/Docx/ODT, advanced layout, collaboration infrastructure** —
  are split into dual-licensed packages: free only if your app is open
  source, priced per month if it is not.

The editor is the bait. The jewels are the subscription. We think that model
is legitimate, but we also think the world deserves one editor that proves
it isn't the only model.

nooq is that proof.

## The commitment

1. **One license.** Everything in this repository — every block, every
   plugin, every export path, every AI feature — is Apache-2.0. There is no
   "XL," "Pro," or "Enterprise" package of source code. There never will be.

2. **The paywall is the roadmap.** The features others gate ship first here:
   - AI-assisted editing and generation
   - Export to PDF, DOCX, ODT, and email-ready HTML
   - Multi-column and advanced layout blocks
   - Real-time collaboration, offline-first

3. **Rug-pull-proof by structure, not promise.**
   - Contributions use a **DCO** (Developer Certificate of Origin)
     sign-off. **No CLA requiring copyright assignment** exists or will be
     adopted. Ownership stays distributed, which makes re-licensing the
     codebase out from under contributors legally impossible rather than
     merely inconvenient.
   - Governance is written down *before* code, in [`GOVERNANCE.md`](GOVERNANCE.md),
     not after a funding round.

4. **Open all the way down.** nooq builds on ProseMirror (MIT) — the same
   genuinely open foundation others build on before walling off the good
   parts. Every layer of the stack nooq depends on must be open. We do not
   build on foundations with paid tiers.

Design decisions are codified in [`PHILOSOPHY.md`](PHILOSOPHY.md) — nine
falsifiable principles, each with a "broken when" test, derived from four
founding stances: framework first, local-first as architecture, AI as
substrate, designed for the people writing in it.

The document semantics those principles imply are specified in
[`DOCUMENT-MODEL.md`](DOCUMENT-MODEL.md) — identity, the CRDT block tree,
the one-transaction protocol, provenance, and AI suggestions as
content-addressed proposals with deterministic revalidation-on-merge
(identity discipline adapted from the [gooi](https://github.com/ngalluzzo)
project, lineage stated in the spec).

5. **Sustainability without capture.** Maintainers must eat, so nooq will
   earn money — from what operations genuinely cost: hosted collaboration
   infrastructure, professional support, deployment and integration work.
   **Never from feature flags.** If nooq ever charges for a `.js` file, this
   project has failed and you should fork it.

## Non-goals

- A closed-source cloud. Hosted services may exist; the code that runs them
  won't be secret.
- CLAs, copyright assignment, or exclusive relicensing rights.
- "Free for open source apps only" anything.
- Competitive AI model hosting. Bring your own model; nooq ships the blocks,
  not a walled garden.

## Status

Pre-everything — except the spec, the core that embarrasses it, and the
CRDT adapter that beats both up. `packages/core` implements DM-2..DM-6
(canonical bytes, digests, the sequential transaction engine, suggestion
revalidation) with zero runtime dependencies. `packages/yjs` replicates
the same model over Yjs: DM-4.7 concurrent-move resolution via a
placement register, DM-4.8 edit-vs-delete, cycle-safe projection — proven
by seeded random op storms that must converge and agree on `evaluate()`
across peers. Bun + TypeScript:

    bun install
    bun test

If you're reading this and want to help, the answer is yes.

## License

Apache-2.0. See [LICENSE](LICENSE).
