import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PEER_INKS, peerInk } from "../src/peer.ts";
import type { Tokens } from "../src/tokens.ts";

const tokens = (await Bun.file(new URL("../tokens.json", import.meta.url)).json()) as Tokens;

/** An independent implementation of the README's rule, via node:crypto. */
function reference(actorId: string): string {
  const hex = createHash("sha256").update(actorId, "utf8").digest("hex");
  return PEER_INKS[parseInt(hex.slice(0, 8), 16) % 6]!;
}

describe("peerInk", () => {
  test("follows the published rule: first 8 hex digits of sha256(actorId) mod 6", async () => {
    for (const id of ["maya", "tomás", "actor:0192f4c8-7d3e-7b21-9a40-5f1c2e8d4b10", "", "🙂 emoji id"]) {
      expect(await peerInk(id)).toBe(reference(id) as (typeof PEER_INKS)[number]);
    }
  });

  test("is stable: every peer computes the same ink for the same writer", async () => {
    const id = "actor:0192f4c8-7d3e-7b21-9a40-5f1c2e8d4b10";
    const inks = await Promise.all(Array.from({ length: 5 }, () => peerInk(id)));
    expect(new Set(inks).size).toBe(1);
  });

  test("reaches all six inks", async () => {
    const seen = new Set(await Promise.all(Array.from({ length: 200 }, (_, i) => peerInk(`actor-${i}`))));
    expect([...seen].sort()).toEqual([...PEER_INKS].sort());
  });

  test("every ink has a token, in the order the README lists them", () => {
    const peers = tokens.color.tokens.filter((t) => t.name.startsWith("peer-")).map((t) => t.name.slice(5));
    expect(peers).toEqual([...PEER_INKS]);
  });
});
