import { expect, test } from "bun:test";
import * as Y from "yjs";
import { applyTextChanges, type TextChange } from "@nooq/core";
import { applyChanges } from "../src/apply.ts";

test("plain inserts match core semantics inside marked text, with omitted or empty marks", () => {
  for (const marks of [undefined, [], ["em"]]) {
    const d = new Y.Doc(), text = d.getText("text"); text.insert(0, "ab", { future: true, strong: true });
    const changes: TextChange[] = [{ retain: 1 }, { insert: "X", ...(marks ? { marks } : {}) }];
    applyChanges(text, changes);
    const after = { s: text.toString(), marks: (text.toDelta() as { insert: string; attributes?: Record<string, unknown> }[]).flatMap(run => Array.from({ length: run.insert.length }, () => Object.keys(run.attributes ?? {}).sort())) };
    expect(after).toEqual(applyTextChanges({ s: "ab", marks: [["future", "strong"], ["future", "strong"]] }, changes)); d.destroy();
  }
});
