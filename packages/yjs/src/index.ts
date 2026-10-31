/**
 * @nooq/yjs — CRDT adapter for the nooq document model (DM-9 reference
 * mapping). Y.Doc is the replicated authority; readState() projects it
 * into the plain DocState every @nooq/core function understands.
 */

export { applyChanges, applyTransaction, newDocument, setText } from "./apply.ts";
export { REGISTER, documentHeader, layout, registerHeader, type DocumentHeader, type Placement, type Register, type YjsLayout } from "./layout.ts";
export { normalize } from "./normalize.ts";
export { admitEnvelope, commitSigned, inspectUpdate, type Admission, type Committed } from "./enforcement.ts";
export { readState } from "./read.ts";
