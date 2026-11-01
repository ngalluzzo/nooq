import { test } from "bun:test";
import { createActorKey, createSecuredDocument, makeBlock, newBlockId, toBase64, type Access, type Op, type Transaction } from "@nooq/core";
import { admitEnvelope, commitSigned, inspectUpdate, newDocument, readState } from "../src/index.ts";

const tx = (ops: Op[], actorId: string, lamport: number): Transaction =>
  ({ id: newBlockId(), actor: { actorId, kind: "human" as const }, lamport, causality: {}, ops });

test("grant probe", async () => {
  const ownerKey = await createActorKey();
  const strangerKey = await createActorKey();
  const ownerParty = { actorId: "human:owner", key: toBase64(ownerKey.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  const genesis: Access = { owner: ownerParty, grants: [], nonce };
  const receiver = newDocument(docId);
  const boot = await commitSigned(newDocument(docId), tx([{ op: "setAccess", access: genesis }], "human:owner", 1), ownerKey, "human:owner");
  console.log("boot:", (await admitEnvelope(receiver, boot.envelope, boot.update)).verdict);

  // mirror the test: pending first (holds), then grant, then re-admit pending
  const block = makeBlock({ type: "nooq.paragraph/v1" }, "human:new");
  const pending = await commitSigned(newDocument(docId), tx([{ op: "insert", block, parent: null }], "human:new", 5), strangerKey, "human:new");
  console.log("pending:", (await admitEnvelope(receiver, pending.envelope, pending.update)).verdict);

  const granted: Access = { ...genesis, grants: [{ actorId: "human:new", key: toBase64(strangerKey.publicBytes), kind: "human", role: "writer" }] };
  const grantEnv = await commitSigned(newDocument(docId), tx([{ op: "setAccess", access: granted }], "human:owner", 2), ownerKey, "human:owner");
  const admission = await admitEnvelope(receiver, grantEnv.envelope, grantEnv.update);
  console.log("grant:", admission.verdict, admission.reason);

  const release = await admitEnvelope(receiver, pending.envelope, pending.update);
  console.log("pending re-admit:", release.verdict, release.reason);
  if (release.verdict !== "allow") {
    const touched = inspectUpdate(receiver, pending.update).touched;
    console.log("pending touched:", JSON.stringify(touched));
    console.log("access now:", JSON.stringify((await readState(receiver)).access?.grants?.map((g) => g.actorId)));
  }
});
