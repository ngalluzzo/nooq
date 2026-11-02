# Proposal 0013: mark runs — the canonical form compacts

**Status: OPEN — 7-day comment period (GOVERNANCE, "significant changes").
Opened: 2026-11-02. Decision of record: issue #9.** Closes DM-10.2.
A DM-3.3 amendment (canonical form only — the sequence CRDT, ops, and
convergence are untouched) plus a `RenderedText` shape change across
consumers. Measured before proposed; the numbers are the proposal.

## The measurement (packages/core/test/mark-churn.test.ts)

10,000 formatted characters, per-character marks as DM-3.3 specifies:

| distinct runs | canonical JSON |
|---|---|
| 10 | 98 KB |
| 1,000 | 93 KB |
| 10,000 | 93 KB |

**~10 bytes per character, floor, regardless of run structure** — because
every character serializes its own marks array (`["bold"],["bold"],…`).
The information content is the runs, not the characters: 10 runs over
10,000 characters is ~150 bytes of actual information in ~93,000 bytes
of canonical form. Every canonical path pays it: block digests (DM-6
evidence), the history store's records, and any wire form carrying
rendered text.

What the measurement exonerated: memory (readText run-shares mark
arrays — EB-8 — and structuredClone preserves the sharing; V8 verified),
and the live freeze path (already-frozen graphs short-circuit at the
root). DM-10.2's cost is serialization, not storage.

## The amendment

`RenderedText` becomes run-indexed:

```json
{ "s": "…10000 chars…", "runs": [ { "marks": ["bold"], "from": 0, "to": 500 }, … ] }
```

- `runs` is minimal, ordered, non-overlapping: adjacent runs with equal
  marks merge; a run with empty marks is omitted. Canonical form is
  therefore **content-equal ⇒ byte-equal** — the property DM-2 requires.
- Per-character `marks` remains the *in-memory projection's* shape
  (consumers index by character); the projection derives `runs` lazily
  where canonical form is needed, or consumers migrate to `runs` — the
  amendment decides per call site, in review.
- **Identity changes once, now, deliberately**: block digests recompute
  over the new form. Envelope signatures are unaffected (they pin Yjs
  update digests, not block digests). There are no deployed documents;
  the cost of re-deriving DM-2's canonical form is at its minimum and
  will only rise.

## The honest cost

Every existing evidence digest (DM-6) invalidates on adoption — this is
a re-genesis of the evidence layer's identity, done before anyone
depends on it. The proposal exists so that decision is made in public,
with the numbers attached, not slipped into a bug fix.
