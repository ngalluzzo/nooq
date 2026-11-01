/**
 * @nooq/yjs — CRDT adapter for the nooq document model (DM-9 reference
 * mapping). Y.Doc is the replicated authority; readState() projects it
 * into the plain DocState every @nooq/core function understands.
 */

export { applyChanges, applyTransaction, keepFormatting, newDocument, setText } from "./apply.ts";
export { REGISTER, documentHeader, layout, registerHeader, type DocumentHeader, type Placement, type Register, type YjsLayout } from "./layout.ts";
export { normalize } from "./normalize.ts";
export { admitEnvelope, applyCaptured, commitSigned, inspectUpdate, sealEnvelope, type Admission, type Captured, type Committed } from "./enforcement.ts";
export { readState } from "./read.ts";
export { clientRegistry, textAuthors, type AuthorRun } from "./registry.ts";
export { createCheckpoint, restoreCheckpoint, stateDigestOf } from "./checkpoint.ts";
