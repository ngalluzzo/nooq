import { expect, test } from "bun:test";
import { defineCommand, definePlugin } from "../src/index.ts";
import { defineAction, defineDOMPlugin, type ActionPlacement } from "../src/dom.ts";

const command = defineCommand<{ block: string }>({ id: "test.action", label: "Action", validateArgs: (a): a is { block: string } => !!a && typeof a === "object" && "block" in a, prepare: () => ({ status: "not-applicable" }) });
const input = { id: "test", label: "Test", command, args: (ctx: { block: string }) => ({ block: ctx.block }) };

test("shared actions normalize typed targets and isolate their placement/key arrays", () => {
  const placements: ActionPlacement[] = ["toolbar"], keys = ["F8"];
  const action = defineAction({ ...input, placements, keys });
  placements.push("slash"); keys.push("F9");
  expect(action.command).toBe(command.id);
  expect(action.placements).toEqual(["toolbar"]); expect(action.keys).toEqual(["F8"]);
  expect(Object.isFrozen(action)).toBe(true); expect(Object.isFrozen(action.keys)).toBe(true);
  // @ts-expect-error Typed command arguments must agree with the target.
  defineAction({ ...input, args: () => ({ block: 123 }) });
});

test("malformed definitions and duplicate contributions are rejected before mounting", () => {
  expect(() => defineAction({ ...input, job: "also-job" } as any)).toThrow("exactly one");
  expect(() => defineAction({ ...input, command: undefined } as any)).toThrow("exactly one");
  expect(() => defineAction({ ...input, placements: ["toolbar", "toolbar"] })).toThrow("placements");
  expect(() => defineAction({ ...input, keys: ["F8", "F8"] })).toThrow("keys");
  expect(() => defineAction({ ...input, when: true } as any)).toThrow("predicate");
  const feature = definePlugin({ id: "test", version: "1.0.0", apiVersion: 1, contributes: { commands: [command] } });
  const action = defineAction(input);
  expect(() => defineDOMPlugin({ id: "test", forPlugin: feature, views: [], actions: [action, action] })).toThrow("Duplicate action");
});
