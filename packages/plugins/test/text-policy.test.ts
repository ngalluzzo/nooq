import { expect, test } from "bun:test";
import { defineCommand } from "../src/index.ts";
import { defineTextPolicy, type TextMark, type TextMode } from "../src/dom.ts";
import { splitBlock } from "../src/essentials.ts";

test("text policies normalize command references and detach nested options", () => {
  const marks: TextMark[] = ["em"], enter = { command: splitBlock };
  const policy = defineTextPolicy({ defaultMode: "rich", marks, enter });
  marks.push("strong");
  expect(policy).toEqual({ defaultMode: "rich", marks: ["em"], enter: { command: splitBlock.id } });
  expect(Object.isFrozen(policy.marks)).toBe(true); expect(Object.isFrozen(policy.enter)).toBe(true);
  expect(defineTextPolicy()).toEqual({ defaultMode: "plain", marks: ["strong", "em", "code"], enter: "newline" });
});

test("invalid text policies and incompatible command arguments are rejected", () => {
  expect(() => defineTextPolicy({ defaultMode: "html" as TextMode })).toThrow("mode");
  expect(() => defineTextPolicy({ marks: ["em", "em"] })).toThrow("marks");
  // 0009: "link" is a reserved bare base; a TOKEN shape in a marks list is structurally invalid.
  expect(() => defineTextPolicy({ marks: ["link:x" as TextMark] })).toThrow("marks");
  expect(() => defineTextPolicy({ enter: { command: "" } })).toThrow("command");
  const wrong = defineCommand<{ other: number }>({ id: "other", label: "Other", validateArgs: (a): a is any => true, prepare: () => ({ status: "not-applicable" }) });
  // @ts-expect-error Enter commands receive SelectionRequest, not arbitrary arguments.
  defineTextPolicy({ enter: { command: wrong } });
});
