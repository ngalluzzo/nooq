# Proposal 0014: content-addressed attachments

**Status: OPEN — 7-day comment period (GOVERNANCE, "significant changes").
Opened: 2026-11-03. Decision of record: issue #12.**
Extends 0009's payload discipline and the SYNC wire; no DOCUMENT-MODEL
change beyond the field's meaning. A new sync capability is a significant
change under GOVERNANCE, so this needs an issue open for at least 7 days.

## The problem, said plainly

An image in a document is bytes, and the document is a log of signed
transactions. Putting the bytes inside the log (a base64 field) makes
every peer sync megabytes per picture through the CRDT — honest no.
Leaving them outside with a bare URL (BlockNote's answer, via host
uploads) is a naked reference: no integrity, no offline story, no proof
the picture is the picture.

## The design

**The document carries the reference; the wire carries the bytes.**

- The image block's fields already carry `src` and `digest?` (shipped in
  plugin-image v1 — the field exists from day one; this proposal fills it
  with meaning). `digest` is the SHA-256 of the bytes, the same digest
  vocabulary as DM-2/DM-6.
- The relay gains a **blob store** beside its envelope log: `PUT blob`
  (bytes in, digest out, deduplicated by content), `GET blob/:digest`.
  Blobs are not transactions — unsigned, content-addressed, inert. The
  digest IS the authenticity: a peer that fetches and re-hashes either
  holds the exact bytes the document named, or knows it was handed
  something else.
- An uploader (the host's `onImageFile` hook) stores the blob, writes the
  block with `{src: "nooq-blob:<digest>", digest}`, and every peer can
  fetch and verify out-of-band, cache forever (content-addressed =
  immutable), and work offline from cache.
- **Envelopes stay small.** The CRDT never sees a byte. Sync of a picture
  is: one ordinary insert transaction (fields only) + one blob fetch.
- Limits: a per-blob size cap (suggested 10 MiB), a per-document blob
  count the relay may enforce, and no execution — blobs are inert bytes
  the surface renders as images, nothing more.

## What this buys over a bare URL

Integrity (the digest proves the bytes), offline (content-addressed
cache), deduplication (same picture, one blob), and host-optionality:
hosts without storage point `src` at their own URLs and omit the digest —
degrading exactly to v1, never breaking.

## Costs and honesty

Relay storage is real bytes now — a host cost, named. Verification is a
re-hash on arrival, negligible. The `nooq-blob:` src scheme is a new
vocabulary word, specified once here.

## Status of the implementation

plugin-image v1 is shipped (block, caption-as-text, paste/drop through
the host hook, digest field). Under this window: the relay blob store,
the `nooq-blob:` fetch path with on-arrival verification, cache, and the
tests that prove a tampered blob fails its digest.
