import "./dom.ts";
import { describe, expect, mock, test } from "bun:test";
import { draftPreview, workingState } from "../src/index.ts";

describe("workingState", () => {
  test("is a polite live region on the AI hand's ground", () => {
    const strip = workingState({ actor: { model: "qwen3-8b" }, onStop: () => {} });
    expect(strip.tagName).toBe("DIV");
    expect(strip.getAttribute("role")).toBe("status");
    expect(strip.getAttribute("aria-live")).toBe("polite");
    expect(strip.classList.contains("nq-working")).toBe(true);
    expect(strip.getAttribute("style")).toBeNull();
  });

  test("says the word working, the kind word AI and the model (DM-5)", () => {
    const strip = workingState({ actor: { model: "qwen3-8b" }, onStop: () => {} });
    expect(strip.querySelector(".nq-working-word")?.classList.contains("nq-ui-caption")).toBe(true);
    expect(strip.querySelector(".nq-working-word")?.textContent).toBe("working");
    expect(strip.querySelector(".nq-working-kind")?.textContent).toBe("AI");
    expect(strip.querySelector(".nq-working-model")?.textContent).toBe("qwen3-8b");
    expect(strip.querySelector(".nq-working-name")).toBeNull();
  });

  test("shows the actor's display name when present", () => {
    const strip = workingState({ actor: { name: "Rewrite assistant", model: "qwen3-8b" }, onStop: () => {} });
    expect(strip.querySelector(".nq-working-name")?.textContent).toBe("Rewrite assistant");
    expect(strip.querySelector(".nq-working-model")?.textContent).toBe("qwen3-8b");
  });

  test("shows the intent as written when present, nothing when absent", () => {
    const withIntent = workingState({ actor: { model: "m" }, intent: "rewrite-block", onStop: () => {} });
    expect(withIntent.querySelector(".nq-working-intent")?.textContent).toBe("rewrite-block");
    expect(workingState({ actor: { model: "m" }, onStop: () => {} }).querySelector(".nq-working-intent")).toBeNull();
  });

  test("Stop is a quiet button with the stop glyph, wired to onStop", () => {
    const onStop = mock(() => {});
    const strip = workingState({ actor: { model: "m" }, onStop });
    const stop = strip.querySelector<HTMLButtonElement>("button")!;
    expect(stop.classList.contains("nq-btn")).toBe(true);
    expect(stop.classList.contains("nq-btn-quiet")).toBe(true);
    expect(stop.textContent).toBe("Stop");
    expect(stop.querySelector("svg[data-glyph='stop']")).not.toBeNull();
    stop.click();
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe("draftPreview", () => {
  test("is aria-hidden draft text in the Document face: the strip's live region is the SR channel (§9)", () => {
    const preview = draftPreview("The pilot ran");
    expect(preview.tagName).toBe("P");
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    expect(preview.classList.contains("nq-draft")).toBe(true);
    expect(preview.classList.contains("nq-doc-body")).toBe(true);
    expect(preview.textContent).toBe("The pilot ran");
    expect(preview.getAttribute("role")).toBeNull();
  });

  test("starts empty and styles only through theme classes", () => {
    const preview = draftPreview();
    expect(preview.textContent).toBe("");
    expect(preview.getAttribute("style")).toBeNull();
    // Text-so-far updates are a plain, idempotent text swap.
    preview.textContent = "so far";
    expect(preview.textContent).toBe("so far");
  });
});
