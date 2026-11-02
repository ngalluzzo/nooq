# Proposal 0012: grant revocation — what "firing someone" can mean

**Status: DRAFT — not yet opened. Drafted: 2026-11-02. Awaits the
product owner's answers to §4 before the window opens.** Closes
DM-10.6. No text below is decided; this document exists to make the
tradeoffs legible enough to decide.

## 1. The theorem first

You cannot un-give a signing key. Every design below is a variation on
one move: make the key the actor still holds **worthless for new
writes**. No design can make the actor forget what they read. Any
honest revocation story says this out loud, in the pitch, on the box.

## 2. The three families

**A. Fork-to-revoke (status quo, formalized).** The owner creates a new
secured document without the revoked actor; everyone migrates.

- Airtight: the old key opens nothing new, and — uniquely among the
  options — the revoked actor cannot see *future* content either.
- Costs: a new document ID (link rot), every peer migrates, and the
  actor keeps writing into the old document forever (into the void).
- DM-15 checkpoints make this far cheaper than it sounds: the fork
  starts from an attested state, not a full log replay.

**B. Grant epochs (key rotation in place).** The access object gains an
`epoch` counter. Grants bind to their epoch; admission requires the
writer's grant to cite the current one. Revocation = the owner advances
the epoch and re-lists every surviving grant under it — a normal
signed, append-only transaction (DM-13 unchanged).

- Same document, same history, no migration; the revoked key fails
  admission for new writes **once peers see the epoch bump** —
  eventual, like every other merge in the system, and that's the
  honest cost: a peer with a stale view still admits a revoked actor's
  writes until it syncs. Those writes stay in history with full
  provenance (verdicts are immutable — proposals/0011's whole point).
- Does nothing about reading: the actor has the bytes they had.

**C. Witness cosigning.** Writes need k-of-n third parties co-signing
the current grant set; revocation = witnesses stop signing.

- Fastest revocation, and the worst fit: witnesses are infrastructure,
  a liveness dependency (breaks offline-first), and a new trust locus —
  the thing the trust layer exists to avoid. Listed for completeness;
  not recommended for v1.

## 3. The recommendation

**B (epochs) for writes, A (fork) kept as the documented escape hatch
for confidentiality incidents, C declined.** B is one wire-visible
field, one admission rule, and zero new infrastructure; its "eventual"
honesty matches the system's existing convergence story. A remains what
you reach for when the question isn't "stop their pen" but "stop their
eyes" — and the pitch should say so plainly.

## 4. Product decisions (1 and 2 answered 2026-11-02 by the owner)

1. **Eventual write-revocation is accepted.** Epochs are the everyday
   answer; fork stays the documented incident tool for "stop their eyes
   too." The pitch states the honesty plainly: *revocation takes effect
   per device at sync time* — the same register as "edits merge when
   you reconnect."
2. **Label the actor, never the mechanics** (the Slack/GitHub pattern;
   the DM-4.9 register):
   - a **"removed" badge** on the actor's identity everywhere it
     appears — roster, hover card, provenance;
   - **one event line in history**: "Maya was removed from this
     document";
   - no per-write labels. A write of hers surfacing after that line
     needs no explanation — the owner connects it the way they connect
     "X left the conversation" and a late message. The mechanics
     sentence ("edit admitted after removal reached this device") lives
     in the provenance detail pane and the spec, nowhere human-facing.
3. **Rotation cost disclosure — OPEN.** Every epoch bump re-signs the
   surviving grants; suggested default: no limit, but the owner sees
   the re-signing bill before confirming (N devices, M surviving
   grants).

## 5. What lands if you say go

Epochs in `access`, the admission rule in `admitEnvelope`, the re-grant
transaction, the stale-epoch notice surface, property tests (revoked
key rejected post-sync on every peer; stale-epoch write admitted then
labeled, never rolled back), and the honest paragraph in the README's
access story.
