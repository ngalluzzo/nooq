# Proposal 0005: history layers and size

**Status: OPEN — 7-day comment period (GOVERNANCE, "significant changes").
Opened: 2026-10-31. Decision of record: issue #4.** Covers DOCUMENT-MODEL Draft 1.8 (DM-14, DM-15, DM-16
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

## Amendments found in implementation

Recorded as the slices land, each with the spec section it changed.

- **Nothing unsigned (DM-12, Draft 1.9).** Yjs's formatting cleanup after
  remote text changes is a local, unsigned transaction. In secured
  documents it never replicates: a fuzz of concurrent marks diverged in 75
  of 80 runs. nooq documents turn it off. Checkpoints depend on this, since
  peers must reproduce each other's state digest.
- **Canonical encoding (SW-5, SYNC Draft 3.2).** `Y.mergeUpdates([x])`
  returns `x`, so it normalized nothing. The canonical encoding is
  `Y.encodeStateAsUpdate`, identical on peers holding the same updates.
- **Secured bootstrap (SW-3, SYNC Draft 3.2).** Verification rebuilds the
  peer's state from its log and requires local state plus the delta to
  equal it plus the receiver's own unconfirmed outbox. Draft 3.1 applied
  the delta before checking the log and failed every reconnect that
  carried offline edits.
- **Genesis is authorized (DM-13, Draft 1.9).** The genesis path checked
  only the owner's signature, so a genesis could carry writes outside the
  document's roots.
- **Adoption attribution (DM-5, DM-12, DM-14.2, Draft 1.9).** `adoptedBy`
  and a proposal's intent existed only in transactions. An adoption now
  writes through a client registered to the proposer with `adoptedBy`, its
  field registers carry `adoptedBy`, and a proposal carries its `intent`.
  Each peer writes each attribution through its own client; the editor had
  shared one client among the human, the AI and every job.
- **`tx` is the signer's description (DM-12, Draft 1.9).** With the log gone,
  nothing binds `tx.ops` to the update; peers authorize effects and their
  registered attribution, and the history store keeps `tx`.
- **No-effect transactions (DM-12, Draft 1.9).** A transaction that changes
  nothing produced an update only because of its log entry. Now it is
  recorded in history and nothing is sealed.
- **Measured after the log left live state:** 10.4 B per edit on the
  reference random workload (raw Yjs 10.3); typing 1.2 B per keystroke
  (was 269); a secured keystroke's update 20 B (was 284). Envelopes stay
  ~500 B each until bursts land.
- **Bursts (DM-14.3, Draft 1.9).** A peer's edit to the block seals the burst,
  so its transaction describes the text it was typed against; a keystroke
  away from the caret counts as a selection change; coalescing is required
  in secured documents and optional in open ones. Measured on typed prose:
  envelopes per character 1.00 → 0.20.
- **Held envelopes release in chains (SW-6, SYNC Draft 3.2).** Out-of-order
  arrival left envelopes held forever in the reference relay, which retried
  once per admission; it now retries until none admits, and the editor
  sends envelopes in commit order.
- **Checkpoint access proof (DM-15, Draft 1.9; SW-3, SYNC Draft 3.2).** A
  checkpoint signer's grant lived only in the state it attests, so a forged
  state could grant its own signer. A checkpoint now travels with the
  latest owner-signed access write, which must carry exactly the attested
  access; the docId binds the owner's key. Gate: a joiner bootstrapping from
  the checkpoint and the envelopes after it reaches the same encoding and
  state digest as replaying from genesis and as the relay; forged,
  ungranted, tampered and unproven checkpoints are refused; a checkpointer
  cannot write.
- **Owner-only rebase (DM-16, Draft 1.9).** A secured genesis is owner-signed,
  so only the owner rebases a secured document; the `rebasedFrom` pin lives
  in the genesis access value and access writes must keep it. Open documents
  have no genesis to pin. Gates: a rebase keeps the root digest, drops
  tombstones and history (under half the bytes on the test document), and
  a fresh peer admits the secured genesis; a version rebuilds its past state
  exactly, attribution included.
- **Host persistence (DM-14.6, Draft 1.10).** The history store had no
  contract for hosts that persist documents. A stored document is its header
  beside its canonical state; hosts keep the history store and the outbox
  beside it. A secured document loaded from an untrusted store must equal the
  replay of its log, and the log is a set: replay admits in any order, so two
  histories merge as their union by `updateDigest` (a gooi workspace's
  history records, say). Gate: an editor reopened from its stored document,
  outbox and history resumes with offline edits delivered, and the stored
  state verifies against the envelopes the host kept.

