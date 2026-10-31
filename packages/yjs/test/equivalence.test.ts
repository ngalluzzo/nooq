import { describe, expect, test } from "bun:test";
import { applyTransaction as engineApply, canonicalJson, emptyDocument, rootDigest } from "@nooq/core";
import { applyTransaction as yjsApply, newDocument, readState } from "../src/index.ts";
import { P1, baseTransactions, rt, txOf } from "./helpers.ts";

describe("adapter/engine equivalence (single peer)", () => {
  test("identical projection for the same op sequence", async () => {
    const { txs, ids } = baseTransactions();
    let engine = emptyDocument("eq-doc");
    const doc = newDocument("eq-doc");
    for (const t of txs) {
      engine = engineApply(engine, t);
      yjsApply(doc, t);
    }

    const follow: ReturnType<typeof txOf>[] = [
      txOf([{ op: "setField", block: ids.p, key: "tone", value: "urgent" }], 10, P1),
      txOf([{ op: "textEdit", block: ids.p, changes: [{ retain: 6, setMarks: ["bold"] }, { retain: 5 }, { insert: " world" }] }], 11, P1),
      txOf([{ op: "move", block: ids.h, newParent: ids.section, index: 0 }], 12, P1),
      txOf([{ op: "delete", block: ids.q }], 13, P1),
      txOf([{ op: "restore", block: ids.q, parent: ids.other }], 14, P1),
      txOf([{ op: "textEdit", block: ids.c, changes: [{ delete: 1 }] }], 15, P1),
    ];
    for (const t of follow) {
      engine = engineApply(engine, t);
      yjsApply(doc, t);
    }

    const projected = readState(doc);
    expect(canonicalJson(projected)).toBe(canonicalJson(engine));
    expect(await rootDigest(projected)).toBe(await rootDigest(engine));
  });

  test("insert with initial fields and children matches engine attribution", async () => {
    const child = { type: "nooq.paragraph/v1", fields: { tone: "calm" } } as const;
    // engine side
    const { makeBlock } = await import("@nooq/core");
    const section = makeBlock({ type: "nooq.section/v1" }, P1);
    const leaf = makeBlock(child, P1);
    const txs = [
      txOf([{ op: "insert", block: leaf, parent: null }], 1, P1),
      txOf([{ op: "insert", block: section, parent: null, index: 0 }], 2, P1),
      txOf([{ op: "move", block: leaf.id, newParent: section.id }], 3, P1),
    ];
    let engine = emptyDocument("eq2");
    const doc = newDocument("eq2");
    for (const t of txs) {
      engine = engineApply(engine, t);
      yjsApply(doc, t);
    }
    expect(canonicalJson(readState(doc))).toBe(canonicalJson(engine));
  });
});
