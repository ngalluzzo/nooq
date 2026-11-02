import { describe, expect, test } from "bun:test";
import { accessExtends, authorize, keyMismatch, partyOf, removedActors, roleOf } from "../src/access.ts";
import type { Access, Grant } from "../src/model.ts";
import type { Envelope } from "../src/actor.ts";
import type { Touched } from "../src/access.ts";
import { registrationOf } from "../src/registry.ts";

/** DM-13.6 (proposals/0012): grant epochs — revocation by rotation. */
const grant = (actorId: string, epoch = 0): Grant => ({ actorId, key: `key-${actorId}`, kind: "human", role: "writer", epoch });
const access = (epoch: number, grants: Grant[], revoked?: string[]): Access => ({ owner: { actorId: "owner", key: "key-owner", kind: "human" }, grants, nonce: "n", epoch, ...(revoked ? { revoked } : {}) });
const env = (signer: string, signerKey = `key-${signer}`): Pick<Envelope, "tx" | "signer"> & { signerKey: string } => ({
  tx: { id: "t1", actor: { actorId: signer, kind: "human" }, lamport: 1, causality: {}, ops: [] },
  signer,
  signerKey,
});
/** DM-12/14.2: the envelope's client is registered to the tx's author. */
const touched = (forEnv: ReturnType<typeof env>, over: Partial<Touched> = {}): Touched => ({ inserts: [], structuralOps: false, otherContentOps: false, accessWrites: false, deletedBlocks: [], unresolved: false, bookkeepingWrites: false, registration: registrationOf(forEnv.tx), accessValues: [], ...over });

describe("grant epochs (DM-13.6, proposals/0012)", () => {
  test("absent epoch reads as 0: pre-epoch documents behave identically", () => {
    const legacy: Access = { owner: { actorId: "owner", key: "k", kind: "human" }, grants: [{ actorId: "w", key: "key-w", kind: "human", role: "writer" }], nonce: "n" };
    expect(roleOf(legacy, "w", "key-w")).toBe("writer");
    expect(authorize(legacy, env("w"), touched(env("w")))).toBe("allow");
    expect(accessExtends(legacy, { ...legacy, grants: [...legacy.grants, grant("w2", 0)] })).toBeTrue();
  });

  test("rotation extends: survivors re-stamped, the omitted actor revoked, additions welcome", () => {
    const before = access(0, [grant("w1", 0), grant("w2", 0), grant("w3", 0)]);
    // Revoke w2; keep w1, w3; add w4.
    const after = access(1, [grant("w1", 1), grant("w3", 1), grant("w4", 1)], ["w2"]);
    expect(accessExtends(before, after)).toBeTrue();
    expect(removedActors(before, after)).toEqual(["w2"]);
    // Authoritative state: w1 still writes, w2 is DENIED (not held), w4 writes.
    expect(authorize(after, env("w1"), touched(env("w1")))).toBe("allow");
    expect(authorize(after, env("w2"), touched(env("w2")))).toBe("deny");
    expect(authorize(after, env("w4"), touched(env("w4")))).toBe("allow");
    expect(partyOf(after, "w2")?.stale ?? false).toBeFalse(); // w2 is GONE at epoch 1, not stale-listed
    expect(roleOf(after, "w2", "key-w2")).toBe("none");
  });

  test("eventual, per device at sync time: a peer still at the old epoch admits the revoked writer", () => {
    const before = access(0, [grant("w2", 0)]);
    const after = access(1, [], ["w2"]); // w2 on the revoked roll everywhere synced
    // The AUTHORITATIVE state denies:
    expect(authorize(after, env("w2"), touched(env("w2")))).toBe("deny");
    // A stale peer (pre-sync view) still admits — the write lands, is never rolled back:
    expect(authorize(before, env("w2"), touched(env("w2")))).toBe("allow");
  });

  test("rotation rules are strict: no skipping, no going back, no rewrites", () => {
    const before = access(1, [grant("w1", 1)]);
    expect(accessExtends(before, access(3, [grant("w1", 3)]))).toBeFalse(); // skip
    expect(accessExtends(before, access(0, [grant("w1", 0)]))).toBeFalse(); // backward
    expect(accessExtends(before, access(2, [grant("w1", 1)]))).toBeFalse(); // survivor not re-stamped
    expect(accessExtends(before, access(2, [{ ...grant("w1", 2), role: "reader" }]))).toBeFalse(); // silent demotion is a rewrite
    expect(accessExtends(before, access(2, [grant("w1", 2), grant("w1", 2)]))).toBeFalse(); // duplicates
    expect(accessExtends(before, access(2, [grant("owner", 2)]))).toBeFalse(); // the owner is never a grant
  });

  test("impersonation still denies across epochs: a revoked actorId with a different key is an attempt", () => {
    const after = access(1, [grant("w1", 1)]);
    expect(keyMismatch(after, "w1", "wrong-key")).toBeTrue(); // w1 is listed with key-w1; a different key claiming their id is an attempt
    expect(keyMismatch(after, "w1", "some-other-key")).toBeTrue();
    // Absent WITHOUT the roll: never granted — hold, never deny (the roll is
    // what separates revoked from not-yet).
    expect(keyMismatch(after, "w2", "any-key")).toBeFalse();
    expect(authorize(after, env("w2", "any-key"), touched(env("w2", "any-key")))).toBe("hold");
  });

  test("re-grant at a later epoch un-revokes: the current grant wins over the roll", () => {
    const rotated = access(1, [], ["w2"]);
    const back = access(2, [grant("w2", 2)], ["w2"]); // re-granted; roll is append-only
    expect(accessExtends(rotated, back)).toBeTrue();
    expect(authorize(back, env("w2"), touched(env("w2")))).toBe("allow");
  });

  test("a rotation that omits an actor without listing them on the roll is malformed", () => {
    const before = access(0, [grant("w1", 0), grant("w2", 0)]);
    expect(accessExtends(before, access(1, [grant("w1", 1)]))).toBeFalse(); // w2 dropped silently
    expect(accessExtends(before, access(1, [grant("w1", 1)], ["w2"]))).toBeTrue();
  });

  test("same-epoch grants remain append-only: prefix preserved, no removals", () => {
    const before = access(1, [grant("w1", 1)]);
    expect(accessExtends(before, access(1, [grant("w1", 1), grant("w2", 1)]))).toBeTrue();
    expect(accessExtends(before, access(1, [grant("w2", 1)]))).toBeFalse(); // cannot drop within an epoch
    expect(accessExtends(before, access(1, []))).toBeFalse();
  });

  test("malformed epochs are not well-formed access", async () => {
    const { wellFormedAccess } = await import("../src/access.ts");
    expect(wellFormedAccess(access(1, [grant("w1", 1)]))).toBeTrue();
    expect(wellFormedAccess(access(1, [grant("w1", 2)]))).toBeFalse(); // grant cites a future epoch
    expect(wellFormedAccess({ ...access(-1, []), epoch: -1 })).toBeFalse();
    expect(wellFormedAccess({ ...access(1.5, []), epoch: 1.5 })).toBeFalse();
  });
});
