import { expect, test } from "bun:test";
import { definePlugin } from "../src/index.ts";
import {
  baseOf, defineDOMPlugin, defineTextPolicy, RESERVED_MARK_BASES, tokenMatchesPolicy, validateMarkBases,
  type BlockViewDefinition, type MarkRenderer, type TextPolicy,
} from "../src/dom.ts";

const headless = definePlugin({ id: "headless.test", version: "1.0.0", apiVersion: 1, contributes: {} });
const renderer: MarkRenderer = (_payload, _text) => ({}) as unknown as Node;
const view = (textPolicy: TextPolicy): BlockViewDefinition => ({ type: "test.note/v1", textPolicy, mount: () => { throw new Error("views are not mounted here"); } });

test("a DOM plugin's view policy may declare reserved bare bases and its own namespaced bases", () => {
  expect(() => defineDOMPlugin({ id: "acme.mentions", forPlugin: headless, views: [view(defineTextPolicy({ marks: [...RESERVED_MARK_BASES] }))] })).not.toThrow();
  const own = defineDOMPlugin({ id: "acme.mentions", forPlugin: headless,
    views: [view(defineTextPolicy({ marks: ["acme.mentions", "acme.mentions.note"], renderMarks: { "acme.mentions.note": renderer } }))] });
  expect(own.views[0]!.textPolicy!.marks).toEqual(["acme.mentions", "acme.mentions.note"]);
  expect(typeof own.views[0]!.textPolicy!.renderMarks!["acme.mentions.note"]).toBe("function");
});

test("defineDOMPlugin rejects a namespace poach with an error that names the rule", () => {
  expect(() => defineDOMPlugin({ id: "acme.mentions", forPlugin: headless, views: [view(defineTextPolicy({ marks: ["other.hilite"] }))] }))
    .toThrow(/namespaced outside plugin acme\.mentions/);
  expect(() => defineDOMPlugin({ id: "acme.mentions", forPlugin: headless,
    views: [view(defineTextPolicy({ marks: ["acme.mentions.note"], renderMarks: { "other.style": renderer } }))] }))
    .toThrow(/namespaced outside plugin acme\.mentions/);
});

test("defineDOMPlugin rejects a foreign bare base with an error that names the rule", () => {
  expect(() => defineDOMPlugin({ id: "acme.mentions", forPlugin: headless, views: [view(defineTextPolicy({ marks: ["fuchsia"] }))] }))
    .toThrow(/Bare mark base "fuchsia" is reserved for nooq/);
  expect(() => validateMarkBases(["em", "link"], "acme.mentions")).not.toThrow();
  expect(() => validateMarkBases(["acme.mentions.note"], "acme.mentions")).not.toThrow();
  expect(() => validateMarkBases(["acme.hijack"], "acme.mentions")).toThrow(/outside plugin/);
  expect(() => validateMarkBases(["bare"], "acme.mentions")).toThrow(/reserved for nooq/);
  expect(() => validateMarkBases(["ok"], "")).toThrow(/plugin's id/);
});

test("baseOf splits on the first colon and bare marks are their own base", () => {
  expect(baseOf("link:9f2c1a")).toBe("link");
  expect(baseOf("acme.mentions.note:abc:def")).toBe("acme.mentions.note");
  expect(baseOf("strong")).toBe("strong");
  expect(baseOf(":orphan")).toBe("");
});

test("token matching goes by base against the policy's admitted bases", () => {
  const withLink = defineTextPolicy({ marks: ["strong", "em", "code", "link"] });
  expect(tokenMatchesPolicy("link:9f2c1a", withLink)).toBe(true);
  expect(tokenMatchesPolicy("strong", withLink)).toBe(true);
  expect(tokenMatchesPolicy("link:9f2c1a", defineTextPolicy())).toBe(false);
  expect(tokenMatchesPolicy("acme.mentions:abc", defineTextPolicy({ marks: ["acme.mentions"] }))).toBe(true);
  expect(tokenMatchesPolicy("acme.mentions:abc", defineTextPolicy({ marks: ["acme.mentions.note"] }))).toBe(false);
});

test("defineTextPolicy keeps a structural check only; ownership lives in the DOM layer", () => {
  const policy = defineTextPolicy({ marks: ["link", "acme.mentions.note"] });
  expect(policy.marks).toEqual(["link", "acme.mentions.note"]);
  expect(() => defineTextPolicy({ marks: ["link:x"] })).toThrow("Invalid text policy marks");
  expect(() => defineTextPolicy({ marks: [" padded "] })).toThrow("Invalid text policy marks");
  expect(() => defineTextPolicy({ renderMarks: { "bad:key": renderer } })).toThrow("renderMarks");
  expect(() => defineTextPolicy({ renderMarks: { link: "not a function" as unknown as MarkRenderer } })).toThrow("renderMarks");
  const contributed = defineTextPolicy({ marks: ["link"], renderMarks: { link: renderer } });
  expect(Object.isFrozen(contributed.renderMarks)).toBe(true);
  expect(contributed.renderMarks!["link"]).toBe(renderer);
});
