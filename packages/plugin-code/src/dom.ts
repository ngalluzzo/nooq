/**
 * The code block's view: mono, unwrapped, Tab-indents, a language picker in
 * the row, copy on hover. The editing engine is the surface's plain text
 * editor (the model's inline text); highlighting is the CM6 layer to come
 * (0003). §7: the whole thing ships as a plugin, the same path anyone has.
 */
import { defineDOMPlugin, defineTextPolicy, type BlockViewContext } from "@nooq/plugins/dom";
import { blockRow } from "@nooq/design";
import { code, codePlugin, LANGUAGES } from "./index.ts";

export const codeDOM = defineDOMPlugin({
  id: "nooq.code.dom", forPlugin: codePlugin,
  views: [{
    type: code.type,
    textPolicy: defineTextPolicy({ defaultMode: "plain", enter: "newline" }),
    mount(ctx: BlockViewContext) {
      const text = ctx.mountTextEditor({ label: "Code block" });
      const editor = text.element as HTMLTextAreaElement;
      // Tab indents two spaces — the code convention — and never leaves the block.
      editor.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        event.preventDefault(); // Tab indents, never leaves the block
        editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const selector = document.createElement("select");
      selector.className = "nq-code-lang nq-ui-caption";
      selector.setAttribute("aria-label", "Code language");
      for (const lang of LANGUAGES) {
        const option = document.createElement("option");
        option.value = lang;
        option.textContent = lang;
        selector.append(option);
      }
      selector.addEventListener("change", () => { void ctx.run("nooq.field.set", { block: ctx.block, key: "lang", value: selector.value }); });
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "nq-code-copy nq-ui-caption";
      copy.textContent = "Copy";
      copy.addEventListener("click", () => {
        void navigator.clipboard?.writeText(editor.value);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      });
      const element = blockRow({ content: [editor, ctx.children.element], kind: "paragraph", actor: "human" });
      const body = element.querySelector<HTMLElement>(".nq-block-body");
      if (body) body.classList.add("nq-code-body");
      const bar = element.querySelector<HTMLElement>(".nq-gutter");
      if (bar) bar.append(selector);
      element.append(copy);
      return { element, update(block) {
        const lang = typeof block.fields.lang === "string" ? block.fields.lang : "text";
        if (selector.value !== lang) selector.value = LANGUAGES.includes(lang) ? lang : "text";
      }, destroy() { text.destroy(); } };
    },
  }],
});
