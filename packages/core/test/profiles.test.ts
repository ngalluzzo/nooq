import { describe, expect, test } from "bun:test";
import { accessExtends, wellFormedAccess, type Access, type Grant } from "../src/index.ts";

const grant = (actorId: string, name?: string): Grant => ({ actorId, key: `k-${actorId}`, kind: "human", role: "writer", ...(name !== undefined ? { name } : {}) });
const access = (epoch: number, grantsIn: readonly Grant[], ownerName?: string): Access => ({
  owner: { actorId: "human:o", key: "k-o", kind: "human", ...(ownerName !== undefined ? { name: ownerName } : {}) },
  grants: [...grantsIn], nonce: "n", epoch,
});

/** DM-13.5 (profiles, stage 1): names travel with trust. */
describe("grant profiles (DM-13.5)", () => {
  test("well-formed: a name is optional, non-empty, bounded; garbage rejects", () => {
    expect(wellFormedAccess(access(0, [grant("human:w", "Maya")], "The Owner"))).toBeTrue();
    expect(wellFormedAccess(access(0, [grant("human:w")]))).toBeTrue(); // absent stays legal
    expect(wellFormedAccess(access(0, [grant("human:w", "")]))).toBeFalse();
    expect(wellFormedAccess(access(0, [grant("human:w", "   ")]))).toBeFalse();
    expect(wellFormedAccess(access(0, [grant("human:w", "x".repeat(121))]))).toBeFalse();
  });

  test("same-epoch extension carries names verbatim (the prefix rule)", () => {
    const before = access(0, [grant("human:w", "Maya")]);
    expect(accessExtends(before, access(0, [grant("human:w", "Maya"), grant("human:n", "Ren")]))).toBeTrue();
  });

  test("rotation preserves names (profiles survive revocations of others)", () => {
    const before = access(0, [grant("human:m", "Maya"), grant("human:t", "Tomás")]);
    const rotated = access(1, [{ ...grant("human:m", "Maya"), epoch: 1 }, { ...grant("human:t", "Tomás"), epoch: 1 }], undefined);
    expect(accessExtends(before, rotated)).toBeTrue();
  });

  test("a silent rename is a REWRITE, not a rotation (the rule that guards names)", () => {
    const before = access(0, [grant("human:m", "Maya")]);
    const renamed = access(1, [{ ...grant("human:m", "MAYA S."), epoch: 1 }]);
    expect(accessExtends(before, renamed)).toBeFalse(); // key/kind/role same, name changed: denied
  });

  test("a name may be ADDED in rotation (absent -> named is honest, not a rewrite of a lie)", () => {
    const before = access(0, [grant("human:m")]);
    const named = access(1, [{ ...grant("human:m", "Maya"), epoch: 1 }]);
    expect(accessExtends(before, named)).toBeTrue(); // ?? undefined equality: absent-to-named is an addition
  });
});
