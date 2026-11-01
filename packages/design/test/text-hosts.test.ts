/** Text hosts and block content wiring: the classes and attributes the theme styles. */
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { Editor, createSurface } from "../../editor/src/index.ts";
import { essentialsDOM } from "../../editor/src/reference.ts";
import { essentials, insertBlock, paragraph } from "../../plugins/src/essentials.ts";

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function mount(mode: "plain" | "rich", text = ""): { root: HTMLElement; editor: Editor; id: string } {
  const editor = new Editor({ docId: `text-hosts-${mode}`, actor: { actorId: "writer" }, plugins: [essentials] });
  const result = editor.commands.run(insertBlock, { type: paragraph.type, parent: null });
  if (result.status !== "applied") throw new Error(result.status);
  const id = result.selection!.block;
  if (text) editor.editText(id, text);
  const surface = createSurface(editor, { plugins: [essentialsDOM], textMode: mode });
  document.body.append(surface.element);
  return { root: surface.element, editor, id };
}

describe("text hosts", () => {
  test("both hosts carry the Document type class, never re-typed sizes", async () => {
    const plain = mount("plain", "Same face");
    const rich = mount("rich", "Same face");
    await flush();
    const area = plain.root.querySelector<HTMLTextAreaElement>("textarea.nq-input")!;
    const host = rich.root.querySelector<HTMLElement>(".nq-rich-text")!;
    expect(area.className).toBe("nq-input nq-doc-body");
    expect(host.className).toContain("nq-input");
    expect(host.className).toContain("nq-rich-text");
    expect(host.className).toContain("nq-doc-body");
    plain.editor.close();
    rich.editor.close();
  });

  test("the plain host hints at the slash menu only while the block is empty", async () => {
    const { root, editor, id } = mount("plain");
    await flush();
    const area = root.querySelector<HTMLTextAreaElement>("textarea.nq-input")!;
    expect(area.getAttribute("placeholder")).toBe("Type / for blocks");
    editor.editText(id, "Now it has content");
    await flush();
    expect(area.hasAttribute("placeholder")).toBe(false);
    editor.applyTextChanges(id, [{ delete: "Now it has content".length }]);
    await flush();
    expect(area.getAttribute("placeholder")).toBe("Type / for blocks");
    editor.close();
  });

  test("the rich host marks emptiness with a data attribute the theme turns into the hint", async () => {
    const { root, editor, id } = mount("rich");
    await flush();
    const host = root.querySelector<HTMLElement>(".nq-rich-text")!;
    expect(host.hasAttribute("data-nq-empty")).toBe(true);
    editor.editText(id, "Typed");
    await flush();
    expect(host.hasAttribute("data-nq-empty")).toBe(false);
    editor.applyTextChanges(id, [{ delete: 5 }]);
    await flush();
    expect(host.hasAttribute("data-nq-empty")).toBe(true);
    editor.close();
  });
});

describe("inline marks", () => {
  test("known marks render as native elements; code carries the code type class", async () => {
    const { root, editor, id } = mount("rich", "bold italic mono");
    editor.applyTextChanges(id, [
      { retain: 4, setMarks: ["strong"] },
      { retain: 1 },
      { retain: 6, setMarks: ["em"] },
      { retain: 1 },
      { retain: 4, setMarks: ["code"] },
    ]);
    await flush();
    const host = root.querySelector<HTMLElement>(".nq-rich-text")!;
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.querySelector("em")?.textContent).toBe("italic");
    const code = host.querySelector("code");
    expect(code?.textContent).toBe("mono");
    expect(code?.classList.contains("nq-code")).toBe(true);
    editor.close();
  });

  test("an unknown mark is kept, dotted by the theme, and named in a title (§8)", async () => {
    const { root, editor, id } = mount("rich", "kept");
    editor.applyTextChanges(id, [{ retain: 4, setMarks: ["future-mark"] }]);
    await flush();
    const unknown = root.querySelector<HTMLElement>("[data-nq-marks]")!;
    expect(unknown.textContent).toBe("kept");
    expect(unknown.getAttribute("data-nq-marks")).toBe(JSON.stringify(["future-mark"]));
    expect(unknown.title).toBe("Unrecognized formatting: future-mark");
    // Several at once are all named, sorted, one span per run.
    editor.applyTextChanges(id, [{ retain: 2 }, { retain: 2, setMarks: ["one", "two"] }]);
    await flush();
    const spans = root.querySelectorAll<HTMLElement>("[data-nq-marks]");
    expect(spans).toHaveLength(2);
    expect(spans[0]!.title).toBe("Unrecognized formatting: future-mark");
    expect(spans[1]!.title).toBe("Unrecognized formatting: one, two");
    editor.close();
  });
});
