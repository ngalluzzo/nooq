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
  computeDigests,
  rootDigest,
  type BlockDigests,
} from "./digests.ts";
export {
  applyTransaction,
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
  type Attribution,
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
