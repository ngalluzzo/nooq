# 0016 — Fingerprint identity

**Status:** Draft
**Author:** @ngalluzzo (lead)
**Opens:** 2026-11-04
**Closes:** 2026-11-11 9:00 PT (or when discussion settles)
**Affects:** DM-12, DM-13; `packages/core/src/identity.ts`, `access.ts`; the secured-document path

## Problem

An `actorId` is a chosen string (`human:maya`). Within a document, DM-13
binds the handle to a key — identity there is cryptographic. **Across
documents, nothing binds them**: any key may claim `human:maya` in the
next document, and two different humans may both pick `human:alex`.
Handles are labels, not facts. The trust layer deserves better than a
naming convention.

## Proposal

An actorId may **derive from its Ed25519 public key** — did:key's lesson,
applied to actor ids. The derivation is canonical: multibase base58btc
(`z…`) over the multicodec-prefixed raw key (`ed 01`), kind-prefixed:

```
actorIdOf("human", publicKey) → "human:z6MkHa…"
```

A **fingerprint document** declares `identity: "fingerprint"` on its
access object. Validation then **proves every handle**: the owner's and
each grant's actorId must derive from the presented key, or the access
is not well-formed at all. A handle cannot be claimed, only proven.

- `createSecuredDocument` derives the owner's id (when not already
  proven) and returns it; hosts echo it into genesis.
- The editor stamps `identity: "fingerprint"` at genesis whenever the
  owner's handle proves their key — new secured documents are fingerprint
  documents by default, free-form stays available for hosts that choose it.
- Free-form documents (absent flag) remain fully legal — the legacy path,
  still key-bound within the document by DM-13. No migration, no break.

### What this is not

- Not a naming system: names are profiles on grants (0015-era DM-13.5),
  chosen by the owner, resolved by every surface. The derived id is
  *who you are*; the name is *what you're called*.
- Not a global registry: derivation is pure and local; two documents
  recognizing the same person requires no server, only the same key.
- Not a breaking change: every existing free-form document validates today.

## Alternatives considered

- **Always enforce (clean break).** Pre-deployment, defensible — but it
  would invalidate every free-form test fixture at once and forbid hosts
  from running loose-identity documents (imports, migrations) deliberately.
  The flag gives the strictness without the mandate.
- **Server-side user registry.** The profile-is-a-document stage-3
  conversation covers discovery without inventing a directory service.

## Test evidence

`packages/core/test/identity.test.ts` — deterministic derivation, distinct
keys yield distinct ids, the claimed handle fails well-formedness in a
fingerprint document, derived ids validate, free-form stays legal. The
three secured stories now run as fingerprint documents end to end
(genesis, peers, the AI suggester), finding rows by **name** — the point
of landing stage 1 first.

## Drawbacks

Derived ids are unreadable in logs and UIs; that is precisely why
profiles-on-grants (DM-13.5) landed first — surfaces show names, ids are
proof. The base58 encoder is ~20 lines, encode-only (verification
re-derives and compares; nothing decodes).
