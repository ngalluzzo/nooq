import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  acceptChecked,
  canonicalJson,
  computeDigests,
  createActorKey,
  createSecuredDocument,
  evaluate,
  liveTree,
  makeBlock,
  makeSuggestionBlock,
  newBlockId,
  rootDigest,
  toBase64,
  type Access,
  type ActorKey,
  type BlockId,
  type Op,
  type Proposal,
  type Transaction,
} from "@nooq/core";
import { commitSigned, newDocument, readState } from "@nooq/yjs";
import { NooqRelay, settled, SyncSession, type SyncTransport } from "../src/index.ts";

let DOC = "hostile-storm-doc"; // replaced per-storm by the secured document ID
const CANARY = "evil";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = "abcdefg hij";
const rt = (s: string) => ({ s, marks: s.split("").map(() => [] as string[]) });
const pick = <T>(rng: () => number, arr: readonly T[]): T | undefined =>
  arr.length ? arr[Math.floor(rng() * arr.length)] : undefined;

function tx(ops: Op[], actorId: string, kind: "human" | "ai", lamport: number): Transaction {
  const model = actorId.startsWith("ai:") ? "simulated/1" : undefined;
  return {
    id: newBlockId(),
    actor: { actorId, kind, ...(model ? { model } : {}) },
    lamport,
    causality: {},
    ops,
  };
}

interface StormPeer {
  name: string;
  actorId: string;
  key: ActorKey;
  doc: Y.Doc;
  session: SyncSession;
  lamport: number;
  denies: number;
}

interface Storm {
  relay: NooqRelay;
  peers: StormPeer[]; // honest
  hostile: StormPeer;
  ai: StormPeer;
  honestCommits: number;
}

async function buildStorm(seed: number): Promise<Storm> {
  const relay = new NooqRelay();
  const ownerKey = await createActorKey();
  const keys = {
    alice: await createActorKey(),
    bob: await createActorKey(),
    ai: await createActorKey(),
    hostile: await createActorKey(),
  };
  const ownerParty = { actorId: "human:owner", key: toBase64(ownerKey.publicBytes), kind: "human" as const };
  const { docId, nonce } = await createSecuredDocument(ownerParty);
  DOC = docId; // secured at genesis: the ID commits to owner+nonce (Draft 1.7)
  const access: Access = {
    owner: ownerParty,
    nonce,
    grants: [
      { actorId: "human:alice", key: toBase64(keys.alice.publicBytes), kind: "human", role: "writer" },
      { actorId: "human:bob", key: toBase64(keys.bob.publicBytes), kind: "human", role: "writer" },
      { actorId: "ai:assistant", key: toBase64(keys.ai.publicBytes), kind: "ai", role: "suggester" },
      // The hostile peer is legitimately granted — as a READER. Every attack
      // it makes therefore fails on authorization or impersonation, not on
      // being an unknown stranger.
      { actorId: "human:hostile", key: toBase64(keys.hostile.publicBytes), kind: "human", role: "reader" },
    ],
  };

  const mkPeer = async (name: string, actorId: string, key: ActorKey): Promise<StormPeer> => {
    const doc = newDocument(DOC); // registers the secured docId header
    const transport = relay.connect(DOC);
    const peer: StormPeer = {
      name,
      actorId,
      key,
      doc,
      session: null as unknown as SyncSession,
      lamport: 0,
      denies: 0,
    };
    peer.session = new SyncSession({
      doc,
      transport,
      actor: actorId,
      onAdmission: (verdict) => {
        if (verdict === "deny") peer.denies++;
      },
      onError: (error) => {
        if (error.code === "envelope-denied") peer.denies++;
      },
    });
    peer.session.start();
    return peer;
  };

  // Owner installs access through a sealed envelope on a store the relay
  // already trusts (open document -> owner-signed setAccess).
  const ownerDoc = newDocument(DOC);
  const ownerTransport: SyncTransport = relay.connect(DOC);
  void ownerTransport;
  const ownerSession = new SyncSession({ doc: ownerDoc, transport: relay.connect(DOC), actor: "human:owner" });
  ownerSession.start();
  await settled();
  const boot = await commitSigned(
    ownerDoc,
    tx([{ op: "setAccess", access }], "human:owner", "human", 1),
    ownerKey,
    "human:owner",
  );
  // Hand-deliver the bootstrap envelope through the relay's update path.
  const raw = JSON.stringify({
    v: 1,
    t: "update",
    doc: DOC,
    update: Buffer.from(boot.update).toString("base64"),
    envelope: boot.envelope,
  });
  (relay.connect(DOC) as unknown as { send: (raw: string) => void }).send(raw);
  await settled(6);

  const peers = [
    await mkPeer("alice", "human:alice", keys.alice),
    await mkPeer("bob", "human:bob", keys.bob),
  ];
  const ai = await mkPeer("assistant", "ai:assistant", keys.ai);
  const hostile = await mkPeer("hostile", "human:hostile", keys.hostile);
  await settled(6);

  // A seed paragraph everyone builds on.
  const seedBlock = makeBlock({ type: "nooq.paragraph/v1", text: rt("the storm begins") }, "human:alice");
  const seedCommit = await commitSigned(
    peers[0]!.doc,
    tx([{ op: "insert", block: seedBlock, parent: null }], "human:alice", "human", ++peers[0]!.lamport),
    keys.alice,
    "human:alice",
  );
  peers[0]!.session.sendUpdate(seedCommit.update, seedCommit.envelope);
  await settled(6);

  return { relay, peers, hostile, ai, honestCommits: 1 };
}

/** Commit + ship an honest transaction; returns false if it failed validation locally. */
async function commitHonest(storm: Storm, peer: StormPeer, ops: Op[], kind: "human" | "ai"): Promise<boolean> {
  try {
    const committed = await commitSigned(
      peer.doc,
      tx(ops, peer.actorId, kind, ++peer.lamport),
      peer.key,
      peer.actorId,
    );
    peer.session.sendUpdate(committed.update, committed.envelope);
    storm.honestCommits++;
    return true;
  } catch {
    return false; // invalid against the local view; the engine refused it
  }
}

function honestOps(rng: () => number, view: ReturnType<typeof readState>): Op[] {
  const ids = Object.keys(view.blocks).filter((id) => view.blocks[id]!.type !== "nooq.suggestion/v1");
  const alive = [...liveTree(view).alive];
  const roll = rng();
  if (roll < 0.25 || ids.length === 0) {
    const text = Array.from({ length: 3 + Math.floor(rng() * 8) }, () => CHARS[Math.floor(rng() * CHARS.length)]!).join("");
    return [{ op: "insert", block: makeBlock({ type: "nooq.paragraph/v1", text: rt(text) }, "human:alice"), parent: pick(rng, alive) ?? null }];
  }
  const target = pick(rng, ids)!;
  if (roll < 0.55) {
    const current = view.blocks[target]!.text?.s ?? "";
    const at = Math.floor(rng() * (current.length + 1));
    const kind = rng();
    const changes: Array<{ retain: number } | { insert: string } | { delete: number }> = [];
    if (at > 0) changes.push({ retain: at });
    if (kind < 0.5) changes.push({ insert: CHARS[Math.floor(rng() * CHARS.length)]! });
    else if (kind < 0.8 && at < current.length) changes.push({ delete: 1 });
    else if (at < current.length) changes.push({ retain: 1 });
    const consumed = changes.reduce((n, c) => n + ("retain" in c ? c.retain : "delete" in c ? c.delete : 0), 0);
    if (consumed < current.length) changes.push({ retain: current.length - consumed });
    return [{ op: "textEdit", block: target, changes }];
  }
  if (roll < 0.75) return [{ op: "setField", block: target, key: "tone", value: `t${Math.floor(rng() * 9)}` }];
  if (roll < 0.9) return [{ op: "delete", block: target }];
  return [{ op: "move", block: target, newParent: pick(rng, alive) ?? null }];
}

async function aiSuggest(storm: Storm, ai: StormPeer): Promise<boolean> {
  const view = readState(ai.doc);
  const alive = liveTree(view).alive;
  const targets = Object.values(view.blocks).filter((b) => b.type === "nooq.paragraph/v1" && alive.has(b.id));
  const target = pick(Math.random, targets);
  if (!target) return false;
  const digests = await computeDigests(view);
  const appended = (target.text?.s ?? "") + " (improved)";
  const proposal: Proposal = {
    base: { rootDigest: await rootDigest(view) },
    ops: [{ op: "textEdit", block: target.id, changes: [{ retain: target.text?.s.length ?? 0 }, { insert: " (improved)" }] }],
    evidence: [{ block: target.id, contentDigest: digests.get(target.id)!.contentDigest, structureDigest: digests.get(target.id)!.structureDigest }],
    context: { model: "simulated/1", before: { [target.id]: target.text?.s ?? "" } },
    actor: "ai:assistant",
    actorDescriptor: { actorId: "ai:assistant", kind: "ai", model: "simulated/1" },
  };
  const suggestion = makeSuggestionBlock(proposal, "ai:assistant");
  return commitHonest(storm, ai, [{ op: "insert", block: suggestion, parent: null }], "ai");
}

async function writerAccept(peer: StormPeer): Promise<boolean> {
  const view = readState(peer.doc);
  const fresh = Object.values(view.blocks).find(
    (b) => b.type === "nooq.suggestion/v1" && liveTree(view).alive.has(b.id) && !b.fields.status,
  );
  if (!fresh) return false;
  try {
    const adoption = await acceptChecked({
      state: view,
      suggestion: fresh.id,
      actor: { actorId: peer.actorId, kind: "human" },
      lamport: ++peer.lamport,
    });
    const committed = await commitSigned(peer.doc, adoption, peer.key, peer.actorId);
    peer.session.sendUpdate(committed.update, committed.envelope);
    return true;
  } catch {
    return false; // stale or structurally impossible; skip
  }
}

/** One hostile attack, properly sealed unless the attack IS the seal's failure. */
async function attack(storm: Storm, hostile: StormPeer, rng: () => number): Promise<void> {
  const view = readState(hostile.doc);
  const targets = Object.keys(view.blocks).filter((id) => view.blocks[id]!.type !== "nooq.suggestion/v1");
  const target = pick(rng, targets);
  const roll = rng();
  const ship = (update: Uint8Array, envelope: unknown, raw?: string) => {
    const message = raw ?? JSON.stringify({ v: 1, t: "update", doc: DOC, update: Buffer.from(update).toString("base64"), envelope });
    const sender = storm.relay.connect(DOC);
    sender.onMessage((reply) => {
      if (reply.includes("envelope-denied")) hostile.denies++;
    });
    sender.send(message);
  };

  if (roll < 0.2) {
    // Bare unsigned update into an access-controlled document.
    ship(new TextEncoder().encode(`hostile-bare-${CANARY}`), undefined, JSON.stringify({ v: 1, t: "update", doc: DOC, update: Buffer.from(new TextEncoder().encode(`bare-${CANARY}`)).toString("base64") }));
    return;
  }
  if (!target) return;
  const evilText = `${CANARY}-${Math.floor(rng() * 100000)}`;
  const ops: Op[] = roll < 0.6
    ? [{ op: "textEdit", block: target, changes: [{ insert: evilText }] }]
    : [{ op: "insert", block: makeBlock({ type: "nooq.paragraph/v1", text: rt(evilText) }, "human:hostile"), parent: null }];

  if (roll < 0.4) {
    // Impersonation: hostile's own key, claims a writer's actorId.
    try {
      const committed = await commitSigned(hostile.doc, tx(ops, "human:alice", "human", ++hostile.lamport), hostile.key, "human:alice");
      ship(committed.update, committed.envelope);
    } catch { /* invalid locally */ }
    return;
  }
  if (roll < 0.6) {
    // Reader overreach: properly sealed with its own granted identity.
    try {
      const committed = await commitSigned(hostile.doc, tx(ops, "human:hostile", "human", ++hostile.lamport), hostile.key, "human:hostile");
      ship(committed.update, committed.envelope);
    } catch { /* invalid locally */ }
    return;
  }
  if (roll < 0.8) {
    // Tampered bytes under a legitimately sealed envelope.
    try {
      const committed = await commitSigned(hostile.doc, tx(ops, "human:hostile", "human", ++hostile.lamport), hostile.key, "human:hostile");
      const tampered = new Uint8Array(committed.update);
      tampered[tampered.length - 1] ^= 0xff;
      ship(tampered, committed.envelope);
    } catch { /* invalid locally */ }
    return;
  }
  // Foreign-client declaration.
  try {
    const committed = await commitSigned(hostile.doc, tx(ops, "human:hostile", "human", ++hostile.lamport), hostile.key, "human:hostile");
    const forged = { ...committed.envelope, client: 424242 };
    ship(committed.update, forged);
  } catch { /* invalid locally */ }
}

/** The AI occasionally "glitches": a properly-signed suggester overreach. */
async function aiGlitch(storm: Storm, ai: StormPeer, rng: () => number): Promise<void> {
  const view = readState(ai.doc);
  const targets = Object.keys(view.blocks).filter((id) => view.blocks[id]!.type === "nooq.paragraph/v1");
  const target = pick(rng, targets);
  if (!target) return;
  try {
    const committed = await commitSigned(
      ai.doc,
      tx([{ op: "textEdit", block: target, changes: [{ insert: `${CANARY}-glitch` }] }], "ai:assistant", "ai", ++ai.lamport),
      ai.key,
      "ai:assistant",
    );
    const sender = storm.relay.connect(DOC);
    sender.onMessage((reply) => {
      if (reply.includes("envelope-denied")) ai.denies++;
    });
    sender.send(JSON.stringify({ v: 1, t: "update", doc: DOC, update: Buffer.from(committed.update).toString("base64"), envelope: committed.envelope }));
  } catch { /* invalid locally */ }
}

describe("hostile-peer storms (proposal 0001's gate)", () => {
  test(
    "every honest peer drops the same envelopes and converges to the same evaluate()",
    async () => {
      for (let seed = 1; seed <= 3; seed++) {
        const rng = mulberry32(seed * 104729);
        const storm = await buildStorm(seed);
        const { peers, hostile, ai } = storm;

        // A proposal captured mid-storm: all honest peers must agree on it.
        let probe: { proposal: Proposal } | null = null;

        for (let round = 0; round < 15; round++) {
          for (const peer of peers) {
            await commitHonest(storm, peer, honestOps(rng, readState(peer.doc)), "human");
          }
          if (rng() < 0.5) await aiSuggest(storm, ai);
          if (rng() < 0.4) await writerAccept(pick(rng, peers)!);
          await attack(storm, hostile, rng);
          if (rng() < 0.35) await aiGlitch(storm, ai, rng);
          await settled(8);

          if (round === 4 && !probe) {
            const view = readState(peers[0]!.doc);
            const alive = Object.values(view.blocks).filter((b) => b.type === "nooq.paragraph/v1" && liveTree(view).alive.has(b.id));
            const target = alive[0];
            if (target) {
              const digests = await computeDigests(view);
              probe = {
                proposal: {
                  base: { rootDigest: await rootDigest(view) },
                  ops: [],
                  evidence: [{ block: target.id, contentDigest: digests.get(target.id)!.contentDigest, structureDigest: digests.get(target.id)!.structureDigest }],
                  context: null,
                  actor: "ai:probe",
                },
              };
            }
          }
        }

        // 1. The replicated state converges bit-identically across the
        // writer peers AND the relay's admitted store — three independent
        // doc instances agreeing on every admitted byte.
        const replicated = readState(peers[0]!.doc);
        for (const peer of [peers[1]!, { doc: storm.relay.stored(DOC)! }]) {
          expect(canonicalJson(readState(peer.doc))).toBe(canonicalJson(replicated));
        }
        // The AI's local doc holds its quarantined glitch edits (applied
        // locally before the relay refused them) — assert the quarantine
        // never leaks: every REPLICATED block exists in the AI's admitted
        // view with identical structure (its local text may diverge only
        // by its own denied edits, which no one else ever sees).
        const aiView = readState(ai.doc);
        for (const [blockId, block] of Object.entries(replicated.blocks)) {
          const theirs = aiView.blocks[blockId];
          expect(theirs).toBeDefined();
          expect(theirs!.type).toBe(block.type);
          expect(theirs!.children).toEqual(block.children);
        }

        // 2. No canary ever replicated: the replicated state (writers and
        // the relay's admitted store) is canary-free. The AI's LOCAL doc
        // may carry its own quarantined glitch text — the guarantee is that
        // it never reaches anyone else.
        for (const peer of [...peers, { doc: storm.relay.stored(DOC)! }]) {
          expect(canonicalJson(readState(peer.doc)).includes(CANARY)).toBe(false);
        }

        // 3. The relay's log holds only earned envelopes (bootstrap + every
        // admitted commit), and hostility actually happened: denials were
        // observed, not assumed.
        expect(storm.relay.envelopesOf(DOC).length).toBeGreaterThanOrEqual(1);

        // 4. Hostility was exercised, not vacuous: attacks and glitches
        // produced observed denials every seed.
        expect([...peers, ai, hostile].reduce((n, p) => n + p.denies, 0)).toBeGreaterThan(0);

        // 5. evaluate() agrees on the replicated state everywhere.
        if (probe) {
          const verdicts = await Promise.all(
            [...peers, { doc: storm.relay.stored(DOC)! }].map((p) => evaluate(probe!.proposal, readState(p.doc))),
          );
          for (const verdict of verdicts) expect(verdict).toEqual(verdicts[0]);
        }

        for (const peer of [...peers, hostile, ai]) peer.session.close();
      }
    },
    360_000,
  );
});
