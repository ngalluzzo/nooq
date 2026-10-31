# Proposal 0001: signed actors and shared rules

**Status: OPEN — 7-day comment period (GOVERNANCE, "significant changes").
Opened: 2026-10-30.** Covers PHILOSOPHY §2/§5 amendments, DOCUMENT-MODEL
Draft 1.6 (DM-12, DM-13), and SYNC Draft 2. The spec text lands with this
proposal; maintainers ratify or amend in the comment period.

## Problem

Actors are self-asserted strings. Nothing ties a log entry to its effects,
Yjs clientIDs are random, and any peer can claim any identity. Rules
therefore cannot be shared — every peer would have to trust every other.

## Change

1. **Signed transactions (DM-12).** One nooq transaction = one Yjs
   transaction = one incremental update, wrapped in an envelope
   `{tx, client, clocks, updateDigest, sig}` — Ed25519 over the canonical
   JSON of `{docId, tx, client, clocks, updateDigest}`. Updates may carry
   only structs from the declared client, in the declared contiguous
   clock range.
2. **Access rules (DM-13).** An optional document `access` header
   (owner + grants) written only by owner-signed envelopes. Roles:
   writer (any op), suggester (suggestion blocks only — AI actors default
   here, enforcing PHILOSOPHY §5), reader (no ops). Adoptions are signed
   by `adoptedBy` and must canonically equal the proposal's ops.
   `authorize` is a pure function applied identically by every peer,
   relays included. Ungranted-but-valid signers pend until grants arrive;
   invalid envelopes are never applied or relayed. Documents without
   `access` behave exactly as today.
3. **Philosophy.** §2: servers are peers that apply the same rules,
   nothing more. §5 gains "Broken when: a peer can claim another actor's
   identity."

## Non-goals (v1)

Grant revocation (fork instead — tracked in DM-10); key rotation;
transport-level identity (SW-9 keeps auth about connections).

## Tests that will gate this

Role matrix; adoption equality; pending grants; forged signatures;
tampered updates; hostile-peer storms (forged actors, suggester
overreach, tampered bytes) where every honest peer drops the same
envelopes and converges to the same `evaluate()`.
