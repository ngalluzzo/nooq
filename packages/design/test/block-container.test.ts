import "./dom.ts";
import { describe, expect, mock, test } from "bun:test";
import {
  blockContainer,
  button,
  CONTAINER_TONES,
  setBlockContainerTone,
  stateTag,
  type ContainerTone,
} from "../src/index.ts";

describe("blockContainer", () => {
  test("renders the header word and every slot the caller provides", () => {
    const body = document.createElement("textarea");
    const children = document.createElement("div");
    const controls = document.createElement("div");
    const state = document.createElement("span");
    const container = blockContainer({ label: "Callout", tone: "neutral", state, body, children, controls });
    expect(container.querySelector(".nq-block-container-label")?.textContent).toBe("Callout");
    expect(container.querySelector(".nq-block-container-state")?.contains(state)).toBe(true);
    expect(container.querySelector(".nq-block-container-body")?.contains(body)).toBe(true);
    expect(container.querySelector(".nq-block-container-children")?.contains(children)).toBe(true);
    expect(container.querySelector(".nq-block-container-controls")?.contains(controls)).toBe(true);
  });

  test("styles only through theme classes: no inline style, ever", () => {
    const container = blockContainer({ label: "Callout", tone: "pencil", body: document.createElement("p") });
    expect(container.getAttribute("style")).toBeNull();
    expect(container.className).toContain("nq-block-container");
  });

  test("without a tone there is no tone word, class or data attribute", () => {
    const container = blockContainer({ label: "Callout" });
    expect(container.querySelector(".nq-block-container-tone")).toBeNull();
    expect(container.hasAttribute("data-tone")).toBe(false);
    for (const tone of CONTAINER_TONES) expect(container.classList.contains(`nq-tone-${tone}`)).toBe(false);
  });

  test("a tone is always also a word in the header (§9)", () => {
    for (const tone of CONTAINER_TONES) {
      const container = blockContainer({ label: "Callout", tone });
      const word = container.querySelector(".nq-block-container-tone");
      expect(word?.textContent).toBe(tone);
      expect(word?.classList.contains("nq-ui-caption")).toBe(true);
      expect(container.classList.contains(`nq-tone-${tone}`)).toBe(true);
      expect(container.dataset.tone).toBe(tone);
    }
  });

  test("the state slot takes arbitrary state, such as a StateTag", () => {
    const container = blockContainer({ label: "Note", tone: "ink", state: stateTag({ state: "accepted" }) });
    expect(container.querySelector(".nq-block-container-state .nq-state")?.textContent).toBe("accepted");
  });

  test("the controls slot hosts real controls", () => {
    const onClick = mock(() => {});
    const container = blockContainer({ label: "Callout", tone: "neutral", controls: button({ label: "Copy", onClick }) });
    container.querySelector<HTMLButtonElement>(".nq-block-container-controls button")!.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("setBlockContainerTone", () => {
  test("refreshes the class, the data attribute and the word in place", () => {
    const container = blockContainer({ label: "Callout", tone: "neutral" });
    setBlockContainerTone(container, "ink");
    expect(container.classList.contains("nq-tone-neutral")).toBe(false);
    expect(container.classList.contains("nq-tone-ink")).toBe(true);
    expect(container.dataset.tone).toBe("ink");
    expect(container.querySelector(".nq-block-container-tone")?.textContent).toBe("ink");
  });

  test("creates the tone word when the container was mounted without one", () => {
    const container = blockContainer({ label: "Callout" });
    setBlockContainerTone(container, "stamp");
    const word = container.querySelector(".nq-block-container-tone");
    expect(word?.textContent).toBe("stamp");
    expect(word?.closest(".nq-block-container-head")).not.toBeNull();
  });

  test("walks every tone without leaving stale classes behind", () => {
    const container = blockContainer({ label: "Callout", tone: "neutral" });
    const walk: ContainerTone[] = ["ink", "pencil", "stamp", "neutral"];
    for (const tone of walk) {
      setBlockContainerTone(container, tone);
      expect(container.className.match(/nq-tone-\w+/g)).toEqual([`nq-tone-${tone}`]);
      expect(container.querySelector(".nq-block-container-tone")?.textContent).toBe(tone);
    }
  });
});
