/**
 * @nooq/core — implementation of DOCUMENT-MODEL.md.
 * Zero runtime dependencies; browser-safe (WebCrypto).
 */

export {
  CanonicalJsonError,
  canonicalJson,
} from "./canonical.ts";
export { fingerprint, sha256, toHex } from "./digest.ts";
export {
  createActorKey,
  fromBase64,
  signEnvelope,
  signingInput,
  toBase64,
  updateDigestOf,
  verifyEnvelope,
  type ActorKey,
  type Clocks,
  type Envelope,
} from "./actor.ts";
export {
  accessExtends,
  adoptionMatches,
  authorize,
  createSecuredDocument,
  isGenesisFor,
  isSecuredDocId,
  keyMismatch,
  roleOf,
  securedDocId,
  wellFormedAccess,
  SUGGESTION_TYPE as ACCESS_SUGGESTION_TYPE,
  type Touched,
  type Verdict,
} from "./access.ts";
export {
  applyTextChanges,
  caretAfterChanges,
  replaceChanges,
  TextChangeError,
  type TextChange,
} from "./text.ts";
export { authorizeLocal, adoptionMatchesState, type LocalPrincipal, type LocalVerdict } from "./local-access.ts";
export { registrationMatches, registrationOf, type ClientRegistration } from "./registry.ts";
export {
  computeDigests,
  rootDigest,
  type BlockDigests,
} from "./digests.ts";
export {
  applyTransaction,
  validateTransaction,
  emptyDocument,
  makeBlock,
  newBlockId,
  validateRenderedText,
  type MakeBlockInit,
} from "./engine.ts";
export { evaluate, type DriftEntry, type DriftReason, type Evaluation, type SuggestionStatus } from "./evaluate.ts";
export {
  SUGGESTION_TYPE,
  STATUS_KEY,
  StaleSuggestionError,
  acceptChecked,
  acceptTransaction,
  evaluateSuggestion,
  makeSuggestionBlock,
  rejectTransaction,
  type AcceptOptions,
} from "./suggestion.ts";
export {
  type ActorDescriptor,
  type ActorId,
  type ActorKind,
  type Access,
  type Attribution,
  type Grant,
  type Role,
  type Block,
  type BlockId,
  type DocState,
  type JsonValue,
  type Op,
  type Proposal,
  type ProposalEvidenceEntry,
  type RenderedText,
  type Transaction,
} from "./model.ts";
export { liveTree, subtreeOf, type LiveTree } from "./tree.ts";
