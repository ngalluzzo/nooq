# Proposal 0011: bounded holds

**Status: OPEN — 7-day comment period (GOVERNANCE, "significant changes").
Opened: 2026-11-02. Decision of record: issue #7.** Covers one SYNC
amendment (a new clause in SW-6, Draft 3.3) closing DM-10.7, and the
corresponding reference implementations (session and relay). No wire
change, no verdict-semantics change — which is the whole point.

## The problem, plainly

An envelope that is validly signed but not yet admissible — its signer's
grant has not arrived, or its base update is unresolved — is held and
re-evaluated after each admission (SW-6). Nothing bounds the hold. One
actor can wedge a peer's memory with held envelopes, and an honest
envelope waiting on a grant that never comes waits forever. The trust
layer has no liveness guarantee.

## The amendment

A peer or relay holding a validly-signed envelope MUST bound the hold,
by age and by count (defaults: 10 minutes, 1,024 per document; both are
policy, not wire). Eviction changes **no verdict**: an evicted hold is
neither admitted nor denied — it is released from memory. The sender MAY
re-offer, and the handshake's full-state exchange naturally re-ships
anything still missing, so an honest envelope whose grant was merely
late pays bounded delay, not loss. Eviction MUST be observable (a
counter, a notice) — never silent memory pressure.

## Why this shape

- **Verdict invariance is non-negotiable.** DM-13's admission decisions
  (admit / hold / deny) are deterministic functions of the document's
  state. Eviction must not become a fourth verdict, so it only releases
  the queue entry; a re-offer re-enters the ordinary path and reaches
  the identical verdict the state now supports.
- **Age + count covers both abuse shapes**: slow-drip holds that never
  resolve (age) and burst floods (count).
- **The relay and clients get the same rule** because SW-6 already binds
  them to the same re-evaluation clause; one bound, two implementations.

## Evidence that will land with this proposal

- Hold → age out → grant arrives → re-offer → admitted; convergence
  identical to never having evicted (property test).
- Flood past the count bound: oldest evicted, admitted envelopes
  unaffected, eviction counter honest.
- The stored envelope log is untouched by eviction (it records admitted
  order; holds were never in it).
