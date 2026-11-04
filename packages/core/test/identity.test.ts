import { describe, expect, test } from "bun:test";
import { createActorKey } from "../src/index.ts";
import { actorIdOf } from "../src/identity.ts";

/** DM-12.4 (stage 2): identity derives from the key — the did:key lesson. */
describe("fingerprint identity (DM-12.4)", () => {
  test("the same key, the same id — deterministic, kind-prefixed, self-describing", async () => {
    const key = await createActorKey();
    const a = actorIdOf("human", key.publicBytes);
    const b = actorIdOf("human", key.publicBytes);
    expect(a).toBe(b);
    expect(a.startsWith("human:z6Mk")).toBe(true); // multibase z + ed25519 multicodec leads 6Mk
    expect(actorIdOf("ai", key.publicBytes).startsWith("ai:z6Mk")).toBe(true);
  });

  test("different keys, different ids — a handle cannot be claimed, only proven", async () => {
    const a = await createActorKey(), b = await createActorKey();
    expect(actorIdOf("human", a.publicBytes)).not.toBe(actorIdOf("human", b.publicBytes));
  });
});

import { wellFormedAccess, type Access } from "../src/index.ts";
import { toBase64 } from "../src/index.ts";

describe("fingerprint documents (DM-12.4 enforcement)", () => {
  test("identity: fingerprint demands proof — a claimed handle is not well-formed", async () => {
    const real = await createActorKey();
    const imposter = await createActorKey();
    const doc: Access = {
      owner: { actorId: "human:z6MkTotallyRealLooking", key: toBase64(real.publicBytes), kind: "human" },
      grants: [{ actorId: "human:tomas", key: toBase64(imposter.publicBytes), kind: "human", role: "writer" }],
      nonce: "n", identity: "fingerprint",
    };
    expect(wellFormedAccess(doc)).toBeFalse(); // neither id derives from its key
  });

  test("derived ids validate: every handle proven by its key", async () => {
    const owner = await createActorKey(), writer = await createActorKey();
    const doc: Access = {
      owner: { actorId: actorIdOf("human", toBase64(owner.publicBytes)), key: toBase64(owner.publicBytes), kind: "human" },
      grants: [{ actorId: actorIdOf("ai", toBase64(writer.publicBytes)), key: toBase64(writer.publicBytes), kind: "ai", role: "suggester" }],
      nonce: "n", identity: "fingerprint",
    };
    expect(wellFormedAccess(doc)).toBeTrue();
  });

  test("free-form documents stay legal (the legacy path, still key-bound by DM-13)", async () => {
    const owner = await createActorKey();
    const doc: Access = {
      owner: { actorId: "human:maya", key: toBase64(owner.publicBytes), kind: "human" },
      grants: [], nonce: "n",
    };
    expect(wellFormedAccess(doc)).toBeTrue(); // no flag, no derivation demand
  });
});
