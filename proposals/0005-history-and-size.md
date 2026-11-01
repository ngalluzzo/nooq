# Proposal 0005: history layers and size

**Status: OPEN — 7-day comment period (GOVERNANCE, "significant changes").
Opened: 2026-10-31.** Covers DOCUMENT-MODEL Draft 1.8 (DM-14, DM-15, DM-16
and amendments to DM-4, DM-5, DM-8, DM-9, DM-10) and SYNC Draft 3. The spec
text lands with this proposal; maintainers ratify or amend in the comment
period.

## Problem

No size or history decision so far was made from measurements. Measured on
the reference adapter (Bun, one block, seeded workloads):

| Workload | Cost |
| --- | --- |
| Raw Yjs, 5,000 random inserts and deletes, GC off | ~10 B per edit (6.6 B with GC on) |
| nooq, one transaction per keystroke | 269 B per keystroke; **89% is the intent log inside the replicated state** |
| nooq, same text pasted once | 62× smaller than typing it |
| Secured nooq, per keystroke | 506 B envelope and 284 B update, beyond state growth |
| A past state as a snapshot (state vector + delete set) | 0.65–6 KB, versus a full copy |

Each transaction is stored three times: in the replicated intent log, in its
envelope, and in its update. Per-edit `textBy` rewrites add ~30 B per
keystroke. Every peer carries all of it forever, and a joiner replays it from
genesis. The CRDT itself is not the cost.

## Decision

Separate history by purpose, each with its own place and lifetime:

| History | Purpose | Granularity | Lives in | Lifetime |
| --- | --- | --- | --- | --- |
| CRDT structure | Merge | Per item | Live state | While any peer may merge |
| Attribution | Who wrote what (PHILOSOPHY §5) | Per character | Live state: a **client registry**, one entry per client | Document life |
| Verification | Prove each change was authorized | Per transaction | The **history store** (secured: the envelope log) | Until a checkpoint covers it; archive after |
| Intent and audit | What action was taken | Per action | The history store | Retention policy |
| Versions | Pin, diff, restore past states | Per version | Snapshots over live state | Policy |
| Undo | One session | Per action | Memory | Session |

## Changes

1. **DM-14.1 Live state carries no logs.** Blocks, roots, placement, access and
   the client registry. No per-transaction intent log and no per-edit
   attribution rewrites (`textBy` is retired; field registers stay, since
   last-writer-wins needs them).
2. **DM-14.2 Attribution by client.** Each Yjs client ID maps once to an actor
   descriptor. Every character's author is its item's client. In secured
   documents an envelope's client must be registered to its signer, so
   attribution is verified, not claimed.
3. **DM-14.3 Transactions are actions.** Text input coalesces into one
   transaction per burst: the local document still applies every keystroke
   at once (EB-6); the burst seals when typing pauses or another action
   starts, within a maximum duration.
4. **DM-14.4 The history store.** DM-4's intent log moves out of replicated
   state into an append-only history store. In secured documents it is the
   envelope log. Durable intent still precedes shipping a change.
5. **DM-15 Checkpoints.** A granted actor signs `{docId, stateVector,
   stateDigest}`. Joiners verify the latest checkpoint and the envelopes after
   it; earlier envelopes are archive. Hosts can be granted a `checkpointer`
   role: it signs checkpoints and nothing else.
6. **DM-16 Rebase.** Explicit compaction: a new lineage whose genesis is the
   current visible state, pinned to the archived old lineage.
7. **DM-9: GC stays off.** It keeps enforcement deterministic (DM-12) and is
   what makes snapshot versions possible. Measured cost: ~50% more state on
   delete-heavy text.

## Parameters (proposed defaults, to confirm in this period)

- Burst: seals after 300 ms without input, at a word boundary or selection
  change, or after 1 s at most.
- Live-state budget: hosts warn at 4 MiB and rebase is recommended at
  16 MiB. Lean, 4 MiB is roughly 400,000 edits; a 10-page document edited by
  a few people for weeks (~50,000 edits) is about 500 KB.
- Checkpoint cadence: host policy; the reference relay checkpoints every
  1,000 envelopes or 1 MiB of envelope log, whichever comes first.

## Tests that will gate this

- Live state on the reference random workload stays at or under 16 B per edit
  with GC off, and holds no intent log.
- A coalesced burst produces one transaction, one update and one envelope.
- Registry attribution names the author of every character, and a secured
  envelope whose client is registered to another actor is denied.
- Bootstrapping from a checkpoint plus later envelopes yields the same state
  digest as replaying from genesis, on every peer.
- A rebase preserves the visible state and pins its archive.

## Non-goals

Per-character deletion attribution in live state (deletions are answered by
the history store); lazily materialized subtrees (DM-10.3 remains open for
residency); automatic rebase without an actor's decision.
