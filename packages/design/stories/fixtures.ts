/** Example content shared by stories. Names and models are illustrative. */

import type { SlashMenuItem, SuggestionCardProps } from "../src/index.ts";

export const DIGESTS = {
  content: "sha256:177298c3e4a1b9d07f62e5a8c1b3d4e5f60718293a4b5c6d7e8f90a1b2c3cfd7",
  structure: "sha256:3411d58e0b7c6a5f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a0f96c68",
  block: "sha256:73c5d0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829304a2f4a",
  stale: "sha256:f881e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7bbcee",
  conflicted: "sha256:2a7570b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e497",
};

export const PILOT_DIFF: SuggestionCardProps["diff"] = [
  { text: "The pilot ran for six weeks " },
  { del: "and most teams seemed to like it" },
  { ins: "across four teams; three kept using it after it ended" },
  { text: "." },
];

export const MENU_ITEMS: SlashMenuItem[] = [
  { label: "Paragraph", type: "nooq.paragraph/v1", glyph: "¶" },
  { label: "Heading 2", type: "nooq.heading/v1", glyph: "H2", hint: "##" },
  { label: "Two columns", type: "nooq.columns/v1", glyph: "||" },
  { label: "Callout", type: "acme.callout/v2", glyph: "i" },
  { label: "Draft with AI", type: "nooq.suggestion/v1", glyph: "AI", ai: true },
];

export function row(...children: Node[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "sb-row";
  div.append(...children);
  return div;
}

export function grid(...children: Node[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "sb-grid";
  div.append(...children);
  return div;
}
