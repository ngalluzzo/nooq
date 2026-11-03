/**
 * The math view: the editing line (the surface's plain text editor, mono)
 * with the KaTeX render live beneath it — the formula IS the preview, no
 * focus/blur flip. Render errors show as the raw source with the problem
 * named (§8 honesty: visible, never dropped), never a broken block.
 */
import { defineDOMPlugin, defineTextPolicy, type BlockViewContext } from "@nooq/plugins/dom";
import { blockRow } from "@nooq/design";
import katex from "katex";
import { math, mathPlugin } from "./index.ts";

export const mathDOM: import("@nooq/plugins/dom").DOMPlugin = defineDOMPlugin({
  id: "nooq.math.dom", forPlugin: mathPlugin,
  views: [{
    type: math.type,
    textPolicy: defineTextPolicy({ defaultMode: "plain", enter: "newline" }),
    mount(ctx: BlockViewContext) {
      const text = ctx.mountTextEditor({ label: "Math (LaTeX)" });
      const source = text.element as HTMLTextAreaElement;
      source.classList.add("nq-math-source");
      const render = document.createElement("div");
      render.className = "nq-math-render";
      render.setAttribute("aria-live", "polite");
      const shell = document.createElement("div");
      shell.className = "nq-math";
      shell.append(source, render, ctx.children.element);
      const element = blockRow({ content: [shell], kind: "paragraph", actor: "human" });
      const draw = (latex: string): void => {
        if (latex.trim() === "") { render.textContent = ""; render.removeAttribute("data-error"); return; }
        try {
          katex.render(latex, render, { displayMode: true, throwOnError: true });
          render.removeAttribute("data-error");
        } catch (cause) {
          // The honest error state: the source stays visible, the problem named.
          render.textContent = latex;
          render.setAttribute("data-error", cause instanceof Error ? cause.message : "render error");
        }
      };
      draw(source.value);
      return { element, update(block) { draw(block.text?.s ?? ""); }, destroy() { text.destroy(); } };
    },
  }],
});
