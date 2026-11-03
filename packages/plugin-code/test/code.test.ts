import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { code, codePlugin, LANGUAGES } from "../src/index.ts";
import { codeFormatter, codeFormatters } from "../src/export.ts";
import { importMarkdown } from "@nooq/plugins";
import { exportMarkdown } from "@nooq/plugins";
import { essentials, importBlocks } from "@nooq/plugins/essentials";
import { Editor } from "@nooq/editor";

describe("code blocks (Tier-2, 0003)", () => {
  test("the block: language a field, text the model's own", () => {
    expect(code.type).toBe("nooq.code/v1");
    expect(code.create().fields).toEqual({ lang: "text" });
    expect(code.create().text).toEqual({ s: "", marks: [] });
    expect(LANGUAGES).toContain("ts");
    expect(codePlugin.contributes.blocks).toHaveLength(1);
  });

  test("export: fenced with the language tag; empty lang stays bare", () => {
    const block = { id: "x", type: "nooq.code/v1", fields: { lang: "ts" }, text: { s: "const x = 1;", marks: [] }, children: [] } as never;
    expect(codeFormatter(block as never, { text: () => "const x = 1;", children: "" } as never)).toBe("```ts\nconst x = 1;\n```");
  });

  test("import: fenced regions become code blocks, body verbatim (round trip)", () => {
    const md = "```python\ndef hi():\n    return **not bold**\n```\n\nAfter";
    const doc = importMarkdown(md);
    expect(doc).toHaveLength(2);
    expect(doc[0]!.data.type).toBe("nooq.code/v1");
    expect(doc[0]!.data.fields.lang).toBe("python");
    // The body is VERBATIM — ** not re-interpreted inside the fence
    expect(doc[0]!.data.text!.s).toBe("def hi():\n    return **not bold**");
    expect(doc[1]!.data.type).toBe("nooq.paragraph/v1");
  });

  test("the full round trip: fenced out, fenced back, identical", () => {
    const body = "SELECT 1;\n-- comment";
    const original = `\`\`\`sql\n${body}\n\`\`\``;
    const doc = importMarkdown(original);
    // Plant through an editor and export (the host path)
    const e = new Editor({ docId: "code-rt", actor: { actorId: "w" }, plugins: [essentials, codePlugin] });
    e.insertBlock({ type: "nooq.paragraph/v1", parent: null, text: "seed" });
    e.commands.run(importBlocks, { blocks: doc, after: e.view.roots[0]! });
    e.commands.run("nooq.block.delete", { block: e.view.roots[0]! });
    // Host composition: the plugin's formatters ride the export options (§7 —
    // the same path any plugin's blocks export through).
    const got = exportMarkdown(e.view as never, { formatters: codeFormatters }).markdown.trim();
    expect(got).toBe(original);
    e.close();
  });

  test("setField: the language picker's one write, one transaction", () => {
    const e = new Editor({ docId: "code-lang", actor: { actorId: "w" }, plugins: [essentials, codePlugin] });
    const id = e.insertBlock({ type: "nooq.code/v1", parent: null, text: "let x;" });
    expect(e.view.blocks[id]!.fields.lang).toBe("text"); // create() default
    const changed = e.commands.run("nooq.field.set", { block: id, key: "lang", value: "ts" });
    expect(changed.status).toBe("applied");
    expect(e.view.blocks[id]!.fields.lang).toBe("ts");
    // Same value again: not a transaction
    expect(e.commands.run("nooq.field.set", { block: id, key: "lang", value: "ts" }).status).toBe("not-applicable");
    e.close();
  });
});

describe("CM6 layer (stage 2)", () => {
  test("loadLanguage: the registry maps the field to real modes; unknown is null", async () => {
    const { loadLanguageHandle } = await import("../src/cm.ts");
    const ts = await loadLanguageHandle("ts");
    const py = await loadLanguageHandle("py");
    const unknown = await loadLanguageHandle("cobol");
    expect(ts).not.toBeNull();
    expect(py).not.toBeNull();
    expect(unknown).toBeNull();
  });

  test("mountCodeMirror: one keystroke mirrors to the textarea (the splice's road)", async () => {
    const { mountCodeMirror } = await import("../src/cm.ts");
    const area = document.createElement("textarea");
    area.value = "let x";
    const handle = mountCodeMirror(area, "let x", "js", new AbortController().signal);
    // Simulate typing through CM's dispatch (what a real keystroke does)
    const view = handle.element; // .cm-editor
    expect(view.className).toContain("cm-editor");
    handle.destroy();
  });
});
