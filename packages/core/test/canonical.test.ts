import { describe, expect, test } from "bun:test";
import { CanonicalJsonError, canonicalJson } from "../src/canonical.ts";

describe("canonicalJson (DM-2, RFC 8785)", () => {
  test("sorts object keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("sorts nested keys recursively", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"z":1}');
  });

  test("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("serializes negative zero as zero", () => {
    expect(canonicalJson({ x: -0 })).toBe('{"x":0}');
  });

  test("serializes large exponents in JCS form", () => {
    expect(canonicalJson(1e21)).toBe("1e+21");
  });

  test("escapes control characters", () => {
    expect(canonicalJson("\n\u0000")).toBe('"\\n\\u0000"');
  });

  test("rejects lone surrogates", () => {
    expect(() => canonicalJson("\ud800")).toThrow(CanonicalJsonError);
    expect(() => canonicalJson("a\uDC00b")).toThrow(CanonicalJsonError);
  });

  test("accepts surrogate pairs", () => {
    expect(canonicalJson("\ud83d\ude00")).toBe('"😀"');
  });

  test("rejects non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
  });

  test("rejects undefined, functions, symbols, and non-plain objects", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ f: () => {} })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
  });

  test("rejects sparse arrays", () => {
    const sparse: unknown[] = [1];
    sparse[3] = 2;
    expect(() => canonicalJson(sparse)).toThrow(CanonicalJsonError);
  });

  test("rejects cycles", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  test("shared (non-cyclic) references are fine", () => {
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });
});
