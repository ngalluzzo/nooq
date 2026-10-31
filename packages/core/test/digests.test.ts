import { describe, expect, test } from "bun:test";
import { applyTransaction, computeDigests, fingerprint, rootDigest } from "../src/index.ts";
import { buildFixture, rt, tx } from "./helpers.ts";

describe("fingerprints (DM-2)", () => {
  test("known vector: empty object", async () => {
    expect(await fingerprint({})).toBe("sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });

  test("known vector: mixed value", async () => {
    expect(await fingerprint({ a: 1, b: [true, null, "x"] })).toBe(
      "sha256:eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1",
    );
  });

  test("key order does not matter", async () => {
    expect(await fingerprint({ b: [true, null, "x"], a: 1 })).toBe(await fingerprint({ a: 1, b: [true, null, "x"] }));
  });
});

describe("block digests (DM-6.1)", () => {
  test("content changes alter contentDigest, not structureDigest", async () => {
    const { state, p } = await buildFixture();
    const before = (await computeDigests(state)).get(p)!;

    const edited = applyTransaction(
      state,
      tx([{ op: "setField", block: p, key: "tone", value: "urgent" }], 5),
    );
    const after = (await computeDigests(edited)).get(p)!;

    expect(after.contentDigest).not.toBe(before.contentDigest);
    expect(after.structureDigest).toBe(before.structureDigest);
  });

  test("structure changes alter structureDigest, not child contentDigest", async () => {
    const { state, section, p } = await buildFixture();
    const beforeSection = (await computeDigests(state)).get(section)!;
    const beforeP = (await computeDigests(state)).get(p)!;

    // Move p to the front of the section.
    const moved = applyTransaction(state, tx([{ op: "move", block: p, newParent: section, index: 0 }], 5));
    const digests = await computeDigests(moved);

    expect(digests.get(section)!.structureDigest).not.toBe(beforeSection.structureDigest);
    expect(digests.get(p)!.contentDigest).toBe(beforeP.contentDigest);
    expect(digests.get(p)!.structureDigest).toBe(beforeP.structureDigest);
  });

  test("Merkle propagation: descendant edit changes ancestor blockDigest and rootDigest", async () => {
    const { state, section, p } = await buildFixture();
    const beforeRoot = await rootDigest(state);
    const before = (await computeDigests(state)).get(section)!;

    const edited = applyTransaction(
      state,
      tx([{ op: "textEdit", block: p, replace: rt("hello brave world") }], 5),
    );
    const afterRoot = await rootDigest(edited);
    const after = (await computeDigests(edited)).get(section)!;

    expect(afterRoot).not.toBe(beforeRoot);
    expect(after.blockDigest).not.toBe(before.blockDigest);
  });

  test("Draft 1.2 regression: descendant content drift never changes an ancestor's structureDigest", async () => {
    const { state, section, p } = await buildFixture();
    const before = (await computeDigests(state)).get(section)!;

    const edited = applyTransaction(
      state,
      tx([{ op: "setField", block: p, key: "tone", value: "urgent" }], 5),
    );
    const after = (await computeDigests(edited)).get(section)!;

    expect(after.structureDigest).toBe(before.structureDigest);
    expect(after.blockDigest).not.toBe(before.blockDigest);
  });

  test("attribution never affects digests (DM-5 is not content)", async () => {
    const { state, p } = await buildFixture();
    const before = await computeDigests(state);

    const mutated = structuredClone(state);
    mutated.blocks[p]!.attribution.fields["tone"] = { actor: "human:9", lamport: 99 };
    const after = await computeDigests(mutated);

    expect(after.get(p)!.blockDigest).toBe(before.get(p)!.blockDigest);
    expect(await rootDigest(mutated)).toBe(await rootDigest(state));
  });
});
