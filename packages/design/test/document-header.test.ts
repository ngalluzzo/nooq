/** Document header: chrome, not content — slots pass through untouched, layout and the rule are all it owns. */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { button, documentHeader, presenceRoster, syncStatus } from "../src/index.ts";

describe("documentHeader", () => {
  test("renders each slot as given: the host's nodes land uncloned, in order, unstyled by the header", () => {
    const title = document.createElement("span"); title.textContent = "Quarterly plan";
    const status = syncStatus({ state: "synced", count: 2 });
    const roster = presenceRoster({ self: "Maya", peers: [] });
    const actions = button({ label: "Share" });
    const header = documentHeader({ title, status, roster, actions });
    expect(header.querySelector(".nq-header-title")?.firstChild).toBe(title); // the very node, uncloned
    const side = Array.from(header.querySelectorAll(".nq-header-side > *"));
    expect(side).toHaveLength(3);
    expect(side[0]).toBe(status);
    expect(side[1]).toBe(roster);
    expect(side[2]).toBe(actions); // trailing, in that order
    expect(header.getAttribute("style")).toBeNull(); // no inline styles in components
    expect(title.getAttribute("style")).toBeNull(); // and none forced onto slot content
  });

  test("is chrome: the strip never sets the title in the Document face", () => {
    const header = documentHeader({ title: "Quarterly plan", status: syncStatus({ state: "local" }), roster: presenceRoster({ self: "Maya", peers: [] }) });
    expect(header.classList.contains("nq-header")).toBe(true);
    const title = header.querySelector<HTMLElement>(".nq-header-title")!;
    expect(title.classList.contains("nq-ui-heading")).toBe(true); // Interface face (sans)
    expect(title.classList.contains("nq-doc-title")).toBe(false); // never the Document face
    expect(title.textContent).toBe("Quarterly plan");
  });

  test("an unbound title renders nothing, and actions is optional", () => {
    const header = documentHeader({ title: undefined, status: syncStatus({ state: "offline" }), roster: presenceRoster({ self: "Maya", peers: [] }) });
    const title = header.querySelector<HTMLElement>(".nq-header-title")!;
    expect(title.childElementCount).toBe(0);
    expect(title.textContent).toBe("");
    expect(header.querySelectorAll(".nq-header-side > *")).toHaveLength(2); // status and roster only
  });
});
