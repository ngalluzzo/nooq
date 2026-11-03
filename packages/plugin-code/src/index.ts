/**
 * Code blocks (0003's decided surface, Tier-2 gap audit): one block type,
 * the language a field — `lang` names the mode ("ts", "py", …, "text" the
 * floor). The text is the model's ordinary inline text; the editing surface
 * is what makes it code: mono, unwrapped, Tab-indents, copy-on-hover.
 * Syntax highlighting arrives as the CM6 view layer (0003's contract).
 */
import { defineBlock, definePlugin } from "@nooq/plugins";
import { paragraph } from "@nooq/plugins/essentials";

export const code = defineBlock({
  type: "nooq.code/v1", label: "Code",
  text: "inline",
  create: () => ({ fields: { lang: "text" }, text: { s: "", marks: [] } }),
  diagnose: () => [],
});

/** The languages the reference names in its picker; the field accepts any
 *  string — unknown modes degrade to plain text, never a failed render. */
export const LANGUAGES: readonly string[] = Object.freeze([
  "text", "ts", "js", "tsx", "jsx", "json", "html", "css", "md", "py", "sh", "rs", "go", "sql",
]);

void paragraph;

export const codePlugin = definePlugin({
  id: "nooq.code", version: "1.0.0", apiVersion: 1,
  contributes: { blocks: [code] },
});

export const CODE_VERSION = codePlugin.version;
