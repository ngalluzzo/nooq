# Proposal 0010: superseded moves

**Status: ACCEPTED — direction of record, locked 2026-11-02.** Covers a
DOCUMENT-MODEL amendment (new DM-4.9; DM-10.1 closes to point at it) and one
editor surface. A philosophy-adjacent document change is a significant change
under GOVERNANCE: this proposal is the public record, open for review; the
project lead is the sole maintainer and owns the window. **No wire change, no
engine change, no digest change** — the amendment codifies detection and UX
for behavior DM-4.7 already produces.

DM-4.7 resolves concurrent placement writes deterministically, and DM-10.1
tracks what that leaves behind: a writer whose move lost the race sees
nothing — their intent silently vanishes from the projection. This proposal
defines that state, makes it observable per peer from data every peer
already holds, and contracts the UX. The foundation's last blocked P1 item
("a notice for a move that lost a concurrent race") unblocks with it.

## Problem

| Finding | Evidence |
| --- | --- |
| Concurrent moves resolve deterministically, but the loser's move vanishes from projection with no acknowledgment. | DM-4.7 (placement register); DM-10.1 ("the UX of 'lost' moves needs study") |
| Both racing transactions persist in history, each carrying causality — concurrency between two moves is decidable from history alone. | DM-2 (`Transaction.causality`); `model.ts` |
| The placement register records its winner (`lamport`, `actor`), so a peer can tell whose write survived a merge. | `layout.ts` `Placement` |
| A move racing a delete is the same mechanism with a tombstone winner, adjacent to edit-vs-delete which already says UI surfaces it. | DM-4.8 |

## Change

### 1. The amendment: DM-4.9 (text verbatim for DOCUMENT-MODEL.md)

> **Concurrent moves and supersession (DM-4.9).** When two concurrent
> transactions each write the placement register for the same block, DM-4.7
> keeps exactly one winner. The losing transaction is **superseded**: it
> remains in history with full provenance, but the projection ignores it.
> Two transactions are concurrent for this purpose when neither's causality
> vector includes the other (DM-2); a move made *after* observing another
> move is a later edit, not a race, and is never supersession.
>
> A race whose writes place the block at the **same destination** is
> agreement, not loss: the register keeps one writer's identity but the
> outcome matches both intents, and no supersession occurred. A move racing
> a delete is the same mechanism with the register keeping the tombstone;
> the mover's surface reports it as deletion, not displacement (DM-4.8
> applies to the wording).
>
> **Observability.** Supersession is decidable per peer with no
> coordination and no wire change: when a merged transaction's causality
> does not include a prior local move on the same block and the register's
> surviving write descends from the merged transaction, the local move was
> superseded. Surfaces SHOULD detect their own supersessions this way.
>
> **UX contract.** A surface showing a supersession names the actor plainly
> ("Maya moved this block at the same time you did. Their move won.") and
> MAY offer reassertion — **a fresh move transaction, causally after
> everything**, which wins through DM-4.7's ordinary resolution. A surface
> MUST NOT retry a superseded move automatically, unwind the winner, or
> merge both intents. History keeps both transactions; export and digests
> are unaffected (placement is the only authority).

DM-10.1 closes as: *"Move under concurrent moves to the same parent —
resolved by DM-4.7; supersession detection and UX by DM-4.9."*

### 2. The editor surface

An editor-level detector (the `onAdmission` pattern): at merge, compare
incoming move ops against local history using the concurrency test; emit a
supersession event carrying block, losing transaction, and winning actor.
The surface renders it as a Notice — a new `superseded` kind, word and
glyph per §9 — with the reassert action ("Move it anyway"), which runs one
fresh `move` op. Detection arms like away markers: nothing fires for
history a writer never raced.

## What deliberately does not change

- **DM-4.7's resolution** — unchanged; reassertion wins *through* it, never
  around it.
- **No wire, engine, or digest change** — causality, the register, and
  history already carry everything; peers without the notice converge
  identically (this is presentation over existing data).

## Acceptance

1. Two editors, two concurrent moves of one block over a real relay: the
   loser's surface shows the notice naming the winner; the winner's shows
   nothing.
2. A race to the same destination: no notice on either side.
3. A later (causally-after) move of the same block: no notice — history
   already tells that story.
4. Reassertion applies as one fresh move op and wins cleanly.
5. A move racing a delete reports deletion (the DM-4.8 wording).
