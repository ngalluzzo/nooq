# nooq Sync Wire Specification

**Status: Draft 2 — pre-implementation.** Implements DM-8 of
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

The responding peer replies:

```json
{ "v": 1, "t": "hello-reply", "doc": "…", "backend": "yjs/1",
  "sv": "<base64>", "delta": "<base64>|null", "rootDigest": "sha256:…|null" }
```

- `delta` is the update covering everything the responder knows that the
  client's `sv` does not — a full-history snapshot for a fresh client.
- When `delta` is non-null, `rootDigest` MUST be the projected root
  digest (DM-6.1) of the responder's converged state after producing
  that delta. The receiver SHOULD apply the delta, project, and compare;
  on mismatch it MUST discard the delta, emit `error`
  (`verification-failed`) locally, and not treat the session as synced.
- For documents with access rules, bootstrap ships the **envelope log**
  (DM-12), so a joining peer verifies every transaction back to the
  first (SW-3).
- Reconnection re-runs the handshake; the delta since the last state
  vector is small by construction.

## SW-4. Steady state

- On any local document change, a session sends
  `{ "t": "update", "update": "<base64>" }`.
- A receiver applies the payload idempotently; duplicates are free
  (SW-1.3). Updates carry no ordering, no acks, and no claims —
  convergence is the CRDT's job, not the wire's.
- A session MAY send `{ "t": "delta", "sv": "<base64>" }` at any time to
  request everything since a state vector; the reply is a `delta`
  message shaped like `hello-reply`'s (`delta`, `rootDigest?`).

## SW-5. Snapshots

A snapshot IS a full-history delta plus its root digest (SW-3); there is
no separate snapshot format. Compaction (DM-8) MAY come later and MUST
preserve provenance (DM-5); until then tombstones and history travel in
every full delta.

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
- MAY evict, rate-limit, or require transport-level authentication —
  these are operational policies on the *connection*, never on
  *document content*. A policy that distinguishes between documents'
  contents is an authority nooq does not have.

## SW-7. Awareness

```json
{ "v": 1, "t": "awareness", "doc": "…", "actor": "<actorId>",
  "name": "<display name|null>", "cursor": { "block": "<blockId>", "offset": 0 } | null }
```

- Cursors anchor to **block identity + character offset** (DM-4), never
  to positions — presence survives reorders and merges.
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
sync*. Open documents (no `access`) still carry no identity. Payloads
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
4. Compaction/truncation of full-history deltas for very old documents.
5. Grant revocation and key rotation (DM-13 non-goals in v1).

## SW-11. What this spec is for

Same rule as the rest: citable by section. "That relay violates SW-6"
is a complete bug report. Changes follow governance, in public, doc
before code.
