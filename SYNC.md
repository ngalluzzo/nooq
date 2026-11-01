# nooq Sync Wire Specification

**Status: Draft 3.3 — pre-implementation.** Implements DM-8 of
[`DOCUMENT-MODEL.md`](DOCUMENT-MODEL.md). Sections are citable as SW-n.
Semantics live in DM-8; this document pins the envelope, the handshake,
bootstrap, verification, and the server contract.

Normative language: MUST, SHOULD, MAY as usual.

---

## SW-1. Principles

1. **Transport-agnostic envelope.** Messages are data; one normative
   transport binding is defined (SW-8) and others MAY follow.
2. **Every peer is a peer.** A hosted nooq service relays, persists, and
   serves — it never resolves, edits, or gates document updates on its
   own authority (PHILOSOPHY §2). Every peer applies the same shared
   rules (DM-13) identically, and no other content policy; there is no
   authority on the wire because there is no policy but the document's
   own (DM-12/13).
3. **Retransmission is free.** Document updates are idempotent CRDT
   payloads; sending one twice changes nothing. Senders need no
   reliability guarantees from the transport beyond eventual delivery,
   and may re-send liberally.
4. **Verification is local.** Bootstrap data carries a claimed root
   digest; receivers re-project and compare (DM-6.1) rather than
   trusting the source.
5. **Awareness is ephemeral.** Presence and cursors are a separate,
   lossy, never-persisted channel (DM-8).

## SW-2. Envelope

Every message is a single UTF-8 JSON object:

```json
{ "v": 1, "t": "<type>", "doc": "<docId>", "…type fields…": "…" }
```

- `v` is the wire major version (`1`). A receiver MUST ignore messages
  with an unknown `v` or unknown `t` (forward compatibility) — except to
  close malformed frames at the transport layer.
- `doc` scopes every message to one document; a connection that receives
  messages for a different document MUST respond with an `error`
  (`bad-doc`) and ignore the message.
- Binary payloads (updates, state vectors) are base64 strings in fields
  named `sv`, `update`, or `delta`.

Message types: `hello`, `hello-reply`, `update`, `delta`, `awareness`,
`error`. When a document has access rules (DM-13), an `update` or
`delta` carries a signed envelope (DM-12) alongside its payload, and
receivers verify before applying.

## SW-3. Handshake and bootstrap

A client opens a session by sending:

```json
{ "v": 1, "t": "hello", "doc": "…", "backend": "yjs/1", "sv": "<base64|null>",
  "update": "<base64|null>" }
```

- `backend` identifies the CRDT payload encoding. `yjs/1` is the only
  backend registered in wire v1; a peer that does not support the
  requested backend MUST reply `error` (`backend-mismatch`) and the
  session ends.
- `sv` is the client's current state vector, base64 — or `null` for a
  fresh peer that has nothing.
- `update` is the client's full local state, base64 — or `null` when
  empty. **The responder MUST apply it before computing its reply**, so
  each side learns everything the other has from the handshake alone.
  *(Draft 1.1 amendment: Draft 1 omitted this field, making the
  handshake receive-only — a peer with pre-existing content could never
  share it, because content only flows on new edits after connecting.
  Found by the first bootstrap test; doc changed before code, per
  SW-11.)*
- In a secured document (DM-13) `update` MUST be `null`: unsigned state
  never travels there. The client's own changes travel as envelopes from
  its outbox instead (SW-4), resent after the reply. *(Draft 3.1: Draft 2
  refused a secured hello's bare state but left the client nothing else to
  send, so a secured document with local state could never reconnect.)*

The responding peer replies:

```json
{ "v": 1, "t": "hello-reply", "doc": "…", "backend": "yjs/1",
  "sv": "<base64>", "delta": "<base64>|null", "rootDigest": "sha256:…|null" }
```

- `delta` is the update covering everything the responder knows that the
  client's `sv` does not — a full-history snapshot for a fresh client.
- When `delta` is non-null, `rootDigest` MUST be the projected root
  digest (DM-6.1) of the responder's converged state after producing
  that delta. A receiver verifies the delta on a scratch copy before
  applying it; on any mismatch it MUST discard the delta, emit `error`
  locally, and not treat the session as synced.
  - **Open documents:** local state plus the delta MUST project to
    `rootDigest` (`verification-failed`).
  - **Secured documents:** the receiver rebuilds the responder's state
    from the checkpoint and envelope log (below), every envelope verified
    (`envelope-log-invalid`), and checks `rootDigest` against it
    (`verification-failed`). Then local state plus the delta MUST equal
    that state plus the receiver's own unconfirmed outbox (SW-4), in the
    canonical encoding (SW-5) (`envelope-log-mismatch`). The delta can
    carry nothing the log does not attest, and edits sealed offline are
    expected, not a mismatch. A secured reply with state but no log fails.
  *(Draft 3.2: Draft 3.1 applied the delta before checking the log,
  accepted a secured document on `rootDigest` alone when no log came, and
  failed every reconnect that carried offline edits, because local state
  was ahead of the digest.)*
- For documents with access rules, bootstrap ships the latest
  **checkpoint** (DM-15) and the **envelope log** after it, so a joining
  peer verifies the checkpoint and every later transaction. Before a
  document's first checkpoint, the log runs back to genesis. Envelopes a
  checkpoint covers are archive and need not travel. The reply carries
  `"checkpoint": {"checkpoint": {…}, "state": "<base64>", "accessProof":
  {…envelope…}}`: the checkpoint, the canonical encoding of the state it
  attests (SW-5), and the owner-signed access write that proves its
  signer's grant (DM-15). A receiver that cannot verify all three emits
  `checkpoint-invalid` and applies nothing.
  *(Draft 3, proposals/0005. Draft 3.2: the reply's shape and the access
  proof.)*
- Reconnection re-runs the handshake; the delta since the last state
  vector is small by construction. After every `hello-reply`, the client
  resends each outbox envelope the reply does not confirm (SW-4).

## SW-4. Steady state

- On any local document change, a session sends
  `{ "t": "update", "update": "<base64>" }`.
- A receiver applies the payload idempotently; duplicates are free
  (SW-1.3). Updates carry no ordering, no acks, and no claims —
  convergence is the CRDT's job, not the wire's.
- A session MAY send `{ "t": "delta", "sv": "<base64>" }` at any time to
  request everything since a state vector; the reply is a `delta`
  message shaped like `hello-reply`'s (`delta`, `rootDigest?`), verified
  the same way when it carries a digest. A secured document never accepts
  a bare `delta` (it carries no envelopes); its peers re-run the handshake.
  *(Draft 3.2.)*
- **Outbox.** A session keeps every envelope it sends in an outbox until a
  handshake confirms the peer has it: the reply's `sv` covers the
  envelope's clocks, or its envelope log contains the envelope's
  `updateDigest`. Sending while disconnected is not an error; the envelope
  waits in the outbox (DM-4: durable intent precedes shipping). Resending
  is free (SW-1.3). A session sends envelopes in commit order, though their
  signatures may finish in any order, so a peer rarely holds one for a
  predecessor. *(Draft 3.2.)* *(Draft 3.1: Draft 2 shipped envelopes once and kept
  none, so edits sealed offline were lost.)*

## SW-5. Snapshots

A snapshot is a checkpoint (DM-15) plus the state it attests, as its
canonical encoding, followed by the envelopes after it (SW-3). A peer
rebuilds the state from that encoding and MUST reproduce both `stateDigest`
and `stateVector` before trusting it.

- **Canonical state encoding.** `stateDigest` is the SHA-256 fingerprint
  of `Y.encodeStateAsUpdate` (Yjs v1) of the state. Peers holding the same
  updates produce identical bytes, because nothing unsigned ever changes a
  secured document (DM-12). A peer MUST reject a checkpoint whose digest
  its own encoding of the received state does not reproduce. *(Draft 3.2:
  Draft 3 named `Y.mergeUpdates`, which returns a single update unchanged
  and so normalizes nothing; the divergence it was meant to absorb came
  from unsigned formatting cleanup, now disabled.)*
- **Compaction** is rebase (DM-16): a new lineage, not truncation of this
  one. Tombstones and CRDT history still travel in a full delta of a
  lineage, but history store entries before its latest checkpoint do not.

*(Draft 3, proposals/0005. Draft 2 said tombstones and all history travel
in every full delta until compaction existed; checkpoints and rebase now
bound both. Doc changed before code, per SW-11.)*

## SW-6. Server-as-peer contract

A hosted nooq sync service is a peer that:

- MUST apply and store updates per document, serve `hello-reply` deltas
  from its store, and relay each accepted update — including the
  `update` payload of a `hello`, which is an update like any other — to
  every other connected session of the same document, unchanged.
- MUST NOT modify, reorder semantically, reject, or gate any update on
  its own content policy. The relay verifies envelopes and drops invalid
  ones exactly like any peer (DM-13 `authorize`), and applies no other
  policy. Conflict resolution happens in every client's CRDT; there is
  nothing to resolve server-side.
- MUST log and relay each update once. An envelope whose update the
  relay already admitted (same `updateDigest`) is a duplicate: it changes
  nothing and is neither logged nor relayed again. A duplicate whose
  signature does not verify is denied, like any forgery. *(Draft 3.1:
  Draft 2 logged every retransmission, and its duplicate path skipped
  signature checks, so forged envelopes over honest bytes reached the
  envelope log.)*
- MUST re-evaluate held envelopes after each admission until none admits:
  releasing one envelope can unblock the next, and an envelope left held
  with no later admission to wake it would never be relayed. *(Draft 3.2:
  the reference relay retried once, so envelopes arriving in reverse order
  stayed held.)*
- MAY evict, rate-limit, or require transport-level authentication —
  these are operational policies on the *connection*, never on
  *document content*. A policy that distinguishes between documents'
  contents is an authority nooq does not have.

## SW-7. Awareness

```json
{ "v": 1, "t": "awareness", "doc": "…", "actor": "<actorId>",
  "name": "<display name|null>",
  "cursor": { "block": "<blockId>", "offset": 0,
              "anchor": { "block": "<blockId>", "offset": 0 } } | null }
```

- Cursors anchor to **block identity + character offset** (DM-4), never
  to positions — presence survives reorders and merges.
- `block`/`offset` is the caret, a selection's moving end. `anchor` is
  OPTIONAL: the fixed end of a selection that is not collapsed. Senders
  SHOULD omit it for a collapsed caret; receivers MUST treat an `anchor`
  equal to the caret as collapsed. A selection MAY span blocks: it covers
  the live text blocks between its ends in document preorder.
  *(Draft 3.3, proposals/0006: Draft 3.2 carried only the caret, though
  DM-8 names selection as awareness.)*
- Awareness is unauthenticated input. Receivers MUST ignore unknown
  fields of `cursor`, and MUST drop a malformed `anchor` — not an object
  with a string `block` and a non-negative integer `offset` — keeping
  the caret. A malformed caret drops the whole cursor. *(Draft 3.3.)*
- Offsets count against the sender's text when sent. Receivers SHOULD
  map a held cursor through every text change they apply after receiving
  it, by the rule that keeps the local selection on its characters
  (EB-7), until the sender's next announcement replaces it. An offset
  past the end of the receiver's text means the sender holds text the
  receiver has not yet admitted (updates verify asynchronously, SW-6, and
  awareness does not wait for them): receivers SHOULD hold it unmapped,
  clamped for display, until that text arrives. *(Draft 3.3.)*
- Senders SHOULD announce on every selection change. While a typing
  burst is open (DM-14.3) a sender MAY hold the caret and announce it
  when the burst seals. *(Draft 3.3.)*
- Awareness is lossy-tolerant: senders SHOULD re-send on change and at
  least every 30s; receivers SHOULD expire entries after ~60s and MUST
  never persist them or fold them into document state.
- Display names are optional and host-supplied. Receiver-side peer
  colors derive from the `actorId` (deterministically — see
  `@nooq/design` peer inks), not from the wire.

## SW-8. Transport bindings

- **Normative v1:** WebSocket, one message per TEXT frame, subprotocol
  `nooq.v1`.
- **Loopback:** an in-memory transport satisfying the same message
  contract is defined for tests and same-process composition (used by
  `@nooq/sync`'s own suite).
- Other bindings MAY follow; the envelope is the contract.

## SW-9. Security and privacy

Wire v2 carries identity where the document demands it: envelope
signatures (DM-12) are actor identity, verified by every peer; transport
authentication remains about *who may connect*, never about *what may
sync*. Open documents (IDs without the secured `nooq:` form, DM-13)
still carry no identity. Payloads
contain everything the document contains; peers that must not see
content must not be peers.

## SW-10. Open questions

1. Binary framing (length-prefixed) instead of base64-in-JSON for
   throughput; deferred until measured (PHILOSOPHY §3 budgets).
2. ~~Incremental update exchange.~~ **Resolved (Draft 1.2)** — the
   original "nested-type insert" diagnosis was wrong: the real cause was
   a Yjs clock gap. The document header was CRDT content consuming
   clocks 0–1 (Yjs correctly pends structs with missing predecessors),
   and the relay never forwarded a joining peer's hello base. Fixes: the
   header is side-channel metadata; hello updates are relayed (SW-6).
   Sessions exchange bare per-transaction increments, and
   pending-until-base is part of SW-4's semantics.
3. Awareness piggybacking on `update` to cut message counts.
4. ~~Compaction/truncation of full-history deltas.~~ **Resolved (Draft 3)**
   — checkpoints (DM-15) bound what joiners verify, and rebase (DM-16)
   bounds live state; a lineage is never truncated.
5. Grant revocation and key rotation (DM-13 non-goals in v1).
6. Unknown fields in known message types. SW-2 governs unknown `v` and
   `t` only; SW-7 rules on `cursor` alone (Draft 3.3). One rule in SW-2
   would let the next additive field land without its own
   (proposals/0006).

## SW-11. What this spec is for

Same rule as the rest: citable by section. "That relay violates SW-6"
is a complete bug report. Changes follow governance, in public, doc
before code.
