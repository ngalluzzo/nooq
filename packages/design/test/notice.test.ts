import "./dom.ts";
import { describe, expect, mock, test } from "bun:test";
import { notice, type NoticeKind } from "../src/index.ts";

const KINDS: readonly NoticeKind[] = ["error", "hold", "denial", "model"];
const GLYPH: Record<NoticeKind, string> = { error: "warning", hold: "access", denial: "stop", model: "model" };

describe("notice", () => {
  test.each(KINDS.map((k) => [k]))(
    "%s is a polite live region with its own glyph and class",
    (kind) => {
      const n = notice({ kind, word: "Something happened." });
      expect(n.getAttribute("role")).toBe("status");
      expect(n.getAttribute("aria-live")).toBe("polite");
      expect(n.getAttribute("data-kind")).toBe(kind);
      expect(n.classList.contains(`nq-notice-${kind}`)).toBe(true);
      expect(n.querySelector(`svg[data-glyph='${GLYPH[kind]}']`)).not.toBeNull();
      expect(n.querySelector(".nq-notice-word")?.textContent).toBe("Something happened.");
    },
  );

  test("each kind keeps its own glyph, so no state depends on color alone (§9)", () => {
    const glyphs = KINDS.map((kind) => notice({ kind, word: "x" }).querySelector("svg")!.getAttribute("data-glyph"));
    expect(new Set(glyphs).size).toBe(KINDS.length);
  });

  test("defaults to the error channel", () => {
    expect(notice({ word: "x" }).getAttribute("data-kind")).toBe("error");
  });

  test("inline and non-blocking: a live region, never a modal (§2, §3)", () => {
    const n = notice({ word: "x" });
    expect(n.tagName).toBe("DIV");
    expect(n.hasAttribute("aria-modal")).toBe(false);
    expect(n.querySelector("dialog")).toBeNull();
  });

  test("an action renders one quiet button wired to the handler", () => {
    const onClick = mock((_: MouseEvent) => {});
    const n = notice({ kind: "hold", word: "Waiting for access", action: { label: "Retry", onClick } });
    const retry = n.querySelector<HTMLButtonElement>("button.nq-btn")!;
    expect(retry.textContent).toBe("Retry");
    expect(retry.classList.contains("nq-btn-quiet")).toBe(true);
    retry.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("no action, no button", () => {
    expect(notice({ word: "x" }).querySelector("button")).toBeNull();
  });

  test("the word sets in the interface body face", () => {
    expect(notice({ word: "x" }).querySelector(".nq-notice-word")?.classList.contains("nq-ui-body")).toBe(true);
  });
});
