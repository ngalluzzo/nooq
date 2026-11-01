/**
 * Raw-update attacks (DM-12/13, Draft 1.7). The honest API cannot produce
 * these: each one is a hand-built Yjs update, sealed by a granted key, that
 * Draft 1.6 admitted. Every honest peer must refuse or hold it.
 */
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  computeDigests,
  createActorKey,
  createSecuredDocument,
  makeBlock,
  makeSuggestionBlock,
  newBlockId,
  registrationOf,
  rootDigest,
  toBase64,
  type Access,
  type ActorKey,
  type Op,
  type Transaction,
} from "@nooq/core";
import { admitEnvelope, commitSigned, layout, newDocument, readState, sealEnvelope } from "../src/index.ts";

const marks = (s: string): string[][] => s.split("").map(() => []);

function tx(ops: Op[], actorId: string, lamport: number, kind: "human" | "ai" = "human"): Transaction {
  return { id: newBlockId(), actor: { actorId, kind }, lamport, causality: {}, ops };
}

/** A secured document with a writer, a suggester and one owner paragraph, admitted by a victim and an attacker. */
async function world() {
  const keys = { owner: await createActorKey(), writer: await createActorKey(), ai: await createActorKey() };
  const owner = { actorId: "human:owner", key: toBase64(keys.owner.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(owner);
  const access: Access = { owner, nonce, grants: [
    { actorId: "human:writer", key: toBase64(keys.writer.publicBytes), kind: "human", role: "writer" },
    { actorId: "ai:assistant", key: toBase64(keys.ai.publicBytes), kind: "ai", role: "suggester" },
  ] };
  const source = newDocument(docId);
  const genesis = await commitSigned(source, tx([{ op: "setAccess", access }], "human:owner", 1), keys.owner, "human:owner");
  const paragraph = makeBlock({ type: "nooq.paragraph/v1", text: { s: "hello world", marks: marks("hello world") } }, "human:owner");
  const inserted = await commitSigned(source, tx([{ op: "insert", block: paragraph, parent: null }], "human:owner", 2), keys.owner, "human:owner");
  const victim = newDocument(docId);
  const attacker = newDocument(docId);
  for (const doc of [victim, attacker]) {
    for (const step of [genesis, inserted]) expect((await admitEnvelope(doc, step.envelope, step.update)).verdict).toBe("allow");
  }
  return { keys, docId, source, victim, attacker, paragraph };
}

/** The honest half of a raw update: register the attacker's own client to the transaction's author (DM-14.2). */
function registerSelf(doc: Y.Doc, transaction: Transaction): void {
  if (!layout(doc).clients.has(String(doc.clientID))) layout(doc).clients.set(String(doc.clientID), registrationOf(transaction));
}

/** Run a raw Yjs mutation and capture exactly its update. */
function raw(doc: Y.Doc, mutate: () => void): Uint8Array {
  let update: Uint8Array | undefined;
  const handler = (u: Uint8Array) => { update = u; };
  doc.on("update", handler);
  doc.transact(mutate, "raw");
  doc.off("update", handler);
  return update!;
}

async function attempt(doc: Y.Doc, victim: Y.Doc, transaction: Transaction, update: Uint8Array, key: ActorKey, signer: string) {
  const envelope = await sealEnvelope(doc, transaction, update, key, signer);
  return admitEnvelope(victim, envelope, update);
}

function varUint(n: number): number[] {
  const out: number[] = [];
  while (n > 127) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

describe("raw-update attacks Draft 1.6 admitted (DM-12/13, Draft 1.7)", () => {
  test("a suggester cannot delete the access header", async () => {
    const { keys, victim, attacker } = await world();
    const honest = tx([], "ai:assistant", 3, "ai");
    const update = raw(attacker, () => {
      registerSelf(attacker, honest);
      layout(attacker).access.delete("access");
    });
    const admission = await attempt(attacker, victim, honest, update, keys.ai, "ai:assistant");
    expect(admission.verdict).toBe("deny");
    expect(readState(victim).access).toBeDefined();
  });

  test("the retired log root is outside the document's roots, and denied (DM-12, Draft 1.8)", async () => {
    const { keys, victim, attacker } = await world();
    const honest = tx([], "human:writer", 3);
    const update = raw(attacker, () => {
      registerSelf(attacker, honest);
      attacker.getArray("log").push([{ forged: true }]);
    });
    expect((await attempt(attacker, victim, honest, update, keys.writer, "human:writer")).verdict).toBe("deny");
    expect(victim.getArray("log").length).toBe(0);
  });

  test("a client registers only itself (DM-12, DM-14.2)", async () => {
    const { keys, victim, attacker, source } = await world();
    const honest = tx([], "human:writer", 3);
    const update = raw(attacker, () => {
      registerSelf(attacker, honest);
      layout(attacker).clients.set(String(source.clientID + 1), registrationOf(tx([], "human:owner", 9)));
    });
    expect((await attempt(attacker, victim, honest, update, keys.writer, "human:writer")).verdict).toBe("deny");
  });

  test("a registry entry is a value, never a nested type", async () => {
    const { keys, victim, attacker } = await world();
    const honest = tx([], "human:writer", 3);
    const update = raw(attacker, () => layout(attacker).clients.set(String(attacker.clientID), new Y.Map() as never));
    expect((await attempt(attacker, victim, honest, update, keys.writer, "human:writer")).verdict).toBe("deny");
  });

  test("control: the same raw write through the writer's own registered client is allowed", async () => {
    const { keys, victim, attacker, paragraph } = await world();
    const honest = tx([{ op: "setField", block: paragraph.id, key: "tone", value: "honest" }], "human:writer", 3);
    const update = raw(attacker, () => {
      registerSelf(attacker, honest);
      (layout(attacker).blocks.get(paragraph.id)!.get("fields") as Y.Map<unknown>).set("tone", "honest");
    });
    expect((await attempt(attacker, victim, honest, update, keys.writer, "human:writer")).verdict).toBe("allow");
  });

  test("a client registered to another actor is denied (DM-12 gate, proposals/0005)", async () => {
    const { keys, victim, attacker, source, paragraph } = await world();
    // The writer signs its own transaction, but writes through the owner's client.
    attacker.clientID = source.clientID;
    const honest = tx([{ op: "setField", block: paragraph.id, key: "tone", value: "forged" }], "human:writer", 3);
    const update = raw(attacker, () => (layout(attacker).blocks.get(paragraph.id)!.get("fields") as Y.Map<unknown>).set("tone", "forged"));
    const admission = await attempt(attacker, victim, honest, update, keys.writer, "human:writer");
    expect(admission.verdict).toBe("deny");
    expect(readState(victim).blocks[paragraph.id]!.fields.tone).toBeUndefined();
  });

  test("a registration is written once: rewriting it is denied", async () => {
    const { keys, victim, attacker, paragraph } = await world();
    const first = await commitSigned(attacker, tx([{ op: "setField", block: paragraph.id, key: "tone", value: "a" }], "human:writer", 3), keys.writer, "human:writer");
    expect((await admitEnvelope(victim, first.envelope, first.update)).verdict).toBe("allow");
    const honest = tx([], "human:writer", 4);
    const update = raw(attacker, () => layout(attacker).clients.set(String(attacker.clientID), { actorId: "human:writer", kind: "human", model: "rewritten" }));
    expect((await attempt(attacker, victim, honest, update, keys.writer, "human:writer")).verdict).toBe("deny");
  });

  test("a writer cannot sign a transaction authored by the owner", async () => {
    const { keys, victim, attacker } = await world();
    const block = makeBlock({ type: "nooq.paragraph/v1" }, "human:owner");
    const asOwner = await commitSigned(attacker, tx([{ op: "insert", block, parent: null }], "human:owner", 3), keys.writer, "human:writer");
    expect((await admitEnvelope(victim, asOwner.envelope, asOwner.update)).verdict).toBe("deny");
    expect(readState(victim).blocks[block.id]).toBeUndefined();
  });

  test("an AI granted as `ai` cannot write as a human", async () => {
    const { keys, victim, attacker } = await world();
    const block = makeBlock({ type: "nooq.paragraph/v1" }, "ai:assistant");
    const relabeled = await commitSigned(attacker, tx([{ op: "insert", block, parent: null }], "ai:assistant", 3, "human"), keys.ai, "ai:assistant");
    expect((await admitEnvelope(victim, relabeled.envelope, relabeled.update)).verdict).toBe("deny");
  });

  test("a suggester cannot delete characters inside a writer's paragraph", async () => {
    const { keys, victim, attacker, paragraph } = await world();
    const honest = tx([], "ai:assistant", 3, "ai");
    const update = raw(attacker, () => {
      registerSelf(attacker, honest);
      (layout(attacker).blocks.get(paragraph.id)!.get("text") as Y.Text).delete(2, 3);
    });
    expect((await attempt(attacker, victim, honest, update, keys.ai, "ai:assistant")).verdict).toBe("deny");
    expect(readState(victim).blocks[paragraph.id]!.text!.s).toBe("hello world");
  });

  test("every id in one roots push counts", async () => {
    const { keys, victim, attacker, paragraph } = await world();
    const honest = tx([], "ai:assistant", 3, "ai");
    const update = raw(attacker, () => {
      registerSelf(attacker, honest);
      layout(attacker).roots.push([newBlockId(), paragraph.id]);
    });
    expect((await attempt(attacker, victim, honest, update, keys.ai, "ai:assistant")).verdict).toBe("deny");
  });

  test("a suggester cannot rewrite an existing suggestion block", async () => {
    const { keys, source, victim, paragraph } = await world();
    const view = readState(source);
    const digests = await computeDigests(view);
    const suggestion = makeSuggestionBlock({
      base: { rootDigest: await rootDigest(view) },
      ops: [{ op: "textEdit", block: paragraph.id, changes: [{ insert: "Hello" }, { delete: 5 }] }],
      evidence: [{ block: paragraph.id, contentDigest: digests.get(paragraph.id)!.contentDigest, structureDigest: digests.get(paragraph.id)!.structureDigest }],
      context: { model: "test" },
      actor: "ai:assistant",
    }, "ai:assistant");
    const proposed = await commitSigned(source, tx([{ op: "insert", block: suggestion, parent: null }], "ai:assistant", 3, "ai"), keys.ai, "ai:assistant");
    expect((await admitEnvelope(victim, proposed.envelope, proposed.update)).verdict).toBe("allow");
    const rewrite = await commitSigned(source, tx([{ op: "setField", block: suggestion.id, key: "note", value: "edited later" }], "ai:assistant", 4, "ai"), keys.ai, "ai:assistant");
    expect((await admitEnvelope(victim, rewrite.envelope, rewrite.update)).verdict).toBe("deny");
  });

  test("the owner cannot write an access-map key other than `access`", async () => {
    const { keys, victim, attacker } = await world();
    const honest = tx([], "human:owner", 3);
    const update = raw(attacker, () => {
      registerSelf(attacker, honest);
      layout(attacker).access.set("shadow", readState(attacker).access);
    });
    expect((await attempt(attacker, victim, honest, update, keys.owner, "human:owner")).verdict).toBe("deny");
  });

  test("an enormous delete range holds without walking its clocks", async () => {
    const { keys, victim, source } = await world();
    const update = Uint8Array.from([...varUint(0), ...varUint(1), ...varUint(source.clientID), ...varUint(1), ...varUint(0), ...varUint(2 ** 31)]);
    const started = performance.now();
    const admission = await attempt(source, victim, tx([], "human:writer", 3), update, keys.writer, "human:writer");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(admission.verdict).not.toBe("allow");
  });
});

describe("honest updates the classifier must not strand (DM-12)", () => {
  test("a long formatted paste resolves without a depth limit", async () => {
    const { keys, source, victim } = await world();
    const s = "ab".repeat(200);
    const block = makeBlock({ type: "nooq.paragraph/v1", text: { s, marks: s.split("").map((_, i) => (i % 2 ? ["bold"] : [])) } }, "human:writer");
    const pasted = await commitSigned(source, tx([{ op: "insert", block, parent: null }], "human:writer", 3), keys.writer, "human:writer");
    expect((Y.decodeUpdate(pasted.update) as unknown as { structs: unknown[] }).structs.length).toBeGreaterThan(128);
    expect((await admitEnvelope(victim, pasted.envelope, pasted.update)).verdict).toBe("allow");
    expect(readState(victim).blocks[block.id]!.text!.s).toBe(s);
  });

  test("a key written twice in one transaction admits", async () => {
    const { keys, source, victim, paragraph } = await world();
    const twice = await commitSigned(source, tx([
      { op: "setField", block: paragraph.id, key: "align", value: "left" },
      { op: "setField", block: paragraph.id, key: "align", value: "center" },
    ], "human:writer", 3), keys.writer, "human:writer");
    expect((await admitEnvelope(victim, twice.envelope, twice.update)).verdict).toBe("allow");
    expect(readState(victim).blocks[paragraph.id]!.fields.align).toBe("center");
  });

  test("an edit that arrives before its base holds, then admits once the base lands", async () => {
    const { keys, source, docId } = await world();
    const late = newDocument(docId);
    const block = makeBlock({ type: "nooq.paragraph/v1", text: { s: "base", marks: marks("base") } }, "human:writer");
    const base = await commitSigned(source, tx([{ op: "insert", block, parent: null }], "human:writer", 3), keys.writer, "human:writer");
    const edit = await commitSigned(source, tx([{ op: "textEdit", block: block.id, changes: [{ retain: 4 }, { insert: "!" }] }], "human:writer", 4), keys.writer, "human:writer");
    // `late` has nothing yet: the edit's parent is unseen.
    expect((await admitEnvelope(late, edit.envelope, edit.update)).verdict).toBe("hold");
    const fresh = newDocument(docId);
    for (const step of [base, edit]) expect((await admitEnvelope(fresh, step.envelope, step.update)).verdict).not.toBe("deny");
  });

  test("documents keep deleted items, so every peer resolves a delete alike", () => {
    expect(newDocument("nooq:open").gc).toBe(false);
  });
});
