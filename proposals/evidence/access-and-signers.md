# Access and signers — investigation record

**Date: 2026-11-01. Question (foundation.md, P1 "Access and signers"):** can
"who can edit and in what role / edits signed and verified (DM-12, DM-13) /
read-only with its reason" be built on what exists, or does sync need
features first? Investigation only; every claim line-cited from the tree at
the time of the round (commit `a115a95`).

## Verdict

**A BUILD for two of the three parts; the third is buildable only in its
weak, transitive form.**

1. **Who can edit and in what role — buildable now, fully.** The complete
   roster (owner + grants with roles and Ed25519 keys) is replicated state
   readable via `editor.view.access` on every peer (`model.ts:63-88`,
   `read.ts:75-80`); grant changes re-render the surface
   (`ChangeEvent.access`, `definitions.ts:56-62`); live presence joins from
   `editor.awareness` (which carries no role — the UI joins by actorId).
2. **Read-only with its reason — buildable now, at the API level.** Deny and
   hold reasons are first-class strings end to end (`local-access.ts:39-84`
   → `AuthorizationError(reason, retryable)` `controller.ts:51-53` →
   `CommandResult {status:"denied", reason, retryable}`). The gaps are
   surface work only (below).
3. **Verified signer — weak form only.** Self is knowable (the host supplied
   the key). For others, "verified" is transitive: any envelope reaching
   `onEnvelope(origin:"remote")` passed `admitEnvelope`'s verify→authorize
   (`enforcement.ts:509-631`). There is no per-actor verified state to query,
   nothing on the awareness wire, and no visibility into held/denied peers.

## Missing, split

**(a) Query surface — data exists, editor/surface wiring only:**
- The Editor never wires `SyncSession.onAdmission`/`onError`
  (`controller.ts:219-236` vs `session.ts:52`) — every remote verdict and
  reason is discarded. The single highest-leverage gap.
- No per-writer verified-state query; held envelopes are private
  (`session.ts:74-75`); `history()` carries transactions without signatures
  (`controller.ts:486-489`) — the envelope log (DM-14.4) is host-realized
  via `onEnvelope` only.
- No `myRole()`/`access()` convenience getters; the DOM surface drops
  `retryable` (`dom.ts:226`) and renders denials as generic errors instead
  of the notice's existing `hold`/`denial` kinds (`notice.ts:35`).
- No proactive read-only mode — denial is discovered by attempting an edit.

**(b) Data/mechanism — sync or core work:**
- The awareness wire carries no role/kind/verification state (an SW-7
  change); no display names in grants (absent grantees show bare actorIds);
  no visibility into OTHER pairs' denied/held envelopes; no eviction of
  forever-held envelopes (`DOCUMENT-MODEL.md:369-371`) — a "pending" badge
  can be permanent; revocation/key rotation are DM-13 v1 non-goals — a UI
  may list grants but never ungrant (removal is a fork, DM-10.6).

## DM-12/DM-13 conformance

No enforcement violations found (signer binding, registered-client,
own-roots, nothing-unsigned, causal-readiness holds, secured-at-genesis,
append-only owner-only access writes, kind binding, suggester limits,
adoption equality, held-pending-grants, checkpoint role limits — all
implemented and tested). Spec-open items: the DM-14.4 envelope-log history
store is host-realized only; envelope eviction is named-but-unimplemented;
the known local-first split (an overreaching signed edit applies locally and
dies at the relay, `signed.test.ts:154-168`) means a UI claiming "your edits
are signed" needs admission feedback — item (a)'s wiring — to correct itself.

## Recommended sequencing

Ship roles + read-only-reason on today's data (zero sync work; the document
header from P2 is the home); land the `onAdmission` wiring as the enabling
change for verified-signer v1 ("their edits arrived verified here"); treat
awareness role/verification fields as the sync-layer feature that upgrades
it.
