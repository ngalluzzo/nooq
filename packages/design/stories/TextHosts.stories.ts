import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect, waitFor } from "storybook/test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { essentials, insertBlock, paragraph } from "../../plugins/src/essentials.ts";
import { resolveColor, type Tokens } from "../src/index.ts";
import tokensJson from "../tokens.json";

const tokens = tokensJson as Tokens;

/** The same sentence in both hosts; the marks land on "Maya", "writes", "in" and "ink.". */
const TEXT = "Maya writes in ink.";

const editors = new Set<Editor>();

function hostSurface(mode: "plain" | "rich"): HTMLElement {
  const editor = new Editor({ docId: `text-hosts-${mode}`, actor: { actorId: "writer" }, plugins: [essentials] });
  editors.add(editor);
  const result = editor.commands.run(insertBlock, { type: paragraph.type, parent: null });
  if (result.status !== "applied") throw new Error(result.status);
  const id = result.selection!.block;
  editor.editText(id, TEXT);
  // Every mark at once: the three this build knows, and one it does not (§8).
  editor.applyTextChanges(id, [
    { retain: 4, setMarks: ["strong"] },
    { retain: 1 },
    { retain: 6, setMarks: ["em"] },
    { retain: 1 },
    { retain: 2, setMarks: ["code"] },
    { retain: 1 },
    { retain: 4, setMarks: ["future-mark"] },
  ]);
  const surface = createSurface(editor, { plugins: [essentialsDOM], textMode: mode });
  const section = document.createElement("section");
  section.className = "nq-surface";
  section.setAttribute("aria-label", mode === "plain" ? "Plain host" : "Rich host");
  section.append(surface.element);
  return section;
}

const meta = {
  title: "Components/Text hosts",
  parameters: {
    docs: {
      description: {
        component:
          "The two text hosts a block can mount: a plain textarea and the rich contenteditable. Both carry the Document type class (`nq-doc-body`) where they are created, so they render the same text identically; the theme adds the writer's caret and selection, and a focus treatment that is the caret itself — no outline, nothing that shifts text (§3). The consumer provides the host element by mounting a text editor; do not restyle it — override the tokens instead. Marks a build does not know are preserved, underlined dotted and titled, so they survive round trips instead of being dropped (§8).",
      },
    },
  },
  beforeEach: () => () => { for (const editor of editors) editor.close(); editors.clear(); },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** "#2343d1" → "rgb(35, 67, 209)", as getComputedStyle reports it. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

export const PlainAndRich: Story = {
  render: () => {
    const wrap = document.createElement("div");
    wrap.className = "sb-stack";
    wrap.style.maxWidth = "var(--nq-measure)";
    // A probe carrying the code type class, for comparing the code mark's face.
    const probe = document.createElement("span");
    probe.className = "nq-code nq-sr";
    probe.textContent = "probe";
    wrap.append(hostSurface("plain"), hostSurface("rich"), probe);
    return wrap;
  },
  play: async ({ canvas, canvasElement, globals }) => {
    const theme = globals.theme === "dark" ? "dark" : "light";
    const plainRegion = canvas.getByRole("region", { name: "Plain host" });
    const richRegion = canvas.getByRole("region", { name: "Rich host" });
    await waitFor(() => expect(plainRegion.querySelector(".nq-input")).not.toBeNull());
    await waitFor(() => expect(richRegion.querySelector(".nq-input")).not.toBeNull());
    const plain = plainRegion.querySelector<HTMLTextAreaElement>("textarea.nq-input")!;
    const rich = richRegion.querySelector<HTMLElement>(".nq-rich-text")!;
    const probe = canvasElementProbe(canvasElement);

    await expect(plain.tagName).toBe("TEXTAREA");
    await expect(rich.getAttribute("contenteditable")).toBe("true");
    // The same text, character for character, in both presentations.
    await expect(plain.value).toBe(TEXT);
    await expect(rich.textContent).toBe(TEXT);

    // The contract: the Document type class types both hosts, never re-typed
    // sizes. One face, one size, one line height — pixel-identical apart from
    // the marks themselves.
    await expect(plain.classList.contains("nq-doc-body")).toBe(true);
    await expect(rich.classList.contains("nq-doc-body")).toBe(true);
    for (const prop of ["fontFamily", "fontSize", "lineHeight", "fontWeight", "letterSpacing"] as const) {
      await expect(getComputedStyle(plain)[prop]).toBe(getComputedStyle(rich)[prop]);
    }

    // Caret and selection in the writer's ink and its wash.
    await expect(getComputedStyle(plain).caretColor).toBe(rgb(resolveColor(tokens, "caret", theme)));
    await expect(getComputedStyle(rich).caretColor).toBe(rgb(resolveColor(tokens, "caret", theme)));
    await expect(getComputedStyle(plain, "::selection").backgroundColor).toBe(rgb(resolveColor(tokens, "selection", theme)));
    await expect(getComputedStyle(rich, "::selection").backgroundColor).toBe(rgb(resolveColor(tokens, "selection", theme)));
    // Focus never shifts text: no outline on the host, no layout-affecting rule.
    for (const host of [plain, rich]) {
      await expect(getComputedStyle(host).outlineStyle).toBe("none");
      await expect(getComputedStyle(host).paddingTop).toBe("0px");
      await expect(getComputedStyle(host).borderTopWidth).toBe("0px");
    }

    // Every mark, in the rich host only — that is the only allowed difference.
    const strong = rich.querySelector<HTMLElement>("strong")!;
    await expect(strong.textContent).toBe("Maya");
    await expect(getComputedStyle(strong).fontWeight).toBe("700");
    const em = rich.querySelector<HTMLElement>("em")!;
    await expect(em.textContent).toBe("writes");
    await expect(getComputedStyle(em).fontStyle).toBe("italic");
    const code = rich.querySelector<HTMLElement>("code")!;
    await expect(code.textContent).toBe("in");
    await expect(code.classList.contains("nq-code")).toBe(true);
    await expect(getComputedStyle(code).fontFamily).toBe(getComputedStyle(probe).fontFamily);
    await expect(getComputedStyle(code).backgroundColor).toBe(rgb(resolveColor(tokens, "paper-sunken", theme)));

    // An unknown mark is preserved, visible, and named (§8).
    const unknown = rich.querySelector<HTMLElement>("[data-nq-marks]")!;
    await expect(unknown.textContent).toBe("ink.");
    await expect(unknown.getAttribute("data-nq-marks")).toBe(JSON.stringify(["future-mark"]));
    await expect(unknown.title).toBe("Unrecognized formatting: future-mark");
    const unknownStyle = getComputedStyle(unknown);
    await expect(unknownStyle.textDecorationLine).toBe("underline");
    await expect(unknownStyle.textDecorationStyle).toBe("dotted");
    await expect(unknownStyle.textDecorationColor).toBe(rgb(resolveColor(tokens, "graphite-muted", theme)));
  },
};

function canvasElementProbe(root: HTMLElement): HTMLElement {
  const probe = root.querySelector<HTMLElement>(".nq-code.nq-sr")!;
  return probe;
}
