/**
 * The diagram view: the source line (mono, quiet) with pele's SVG live
 * beneath. mount() reads fonts from CSS and adapts to the container — the
 * block-view-native limb; render errors show the source with the problem
 * named. pele escapes diagram text and filters links/styles: the wire's
 * untrusted diagrams render defanged.
 */
import { defineDOMPlugin, defineTextPolicy, type BlockViewContext } from "@nooq/plugins/dom";
import { blockRow } from "@nooq/design";
import { mount as peleMount } from "pele";
import { diagram, diagramPlugin } from "./index.ts";

export const diagramDOM: import("@nooq/plugins/dom").DOMPlugin = defineDOMPlugin({
  id: "nooq.diagram.dom", forPlugin: diagramPlugin,
  views: [{
    type: diagram.type,
    textPolicy: defineTextPolicy({ defaultMode: "plain", enter: "newline" }),
    mount(ctx: BlockViewContext) {
      const text = ctx.mountTextEditor({ label: "Diagram (Mermaid)" });
      const source = text.element as HTMLTextAreaElement;
      source.classList.add("nq-diagram-source");
      source.setAttribute("placeholder", "flowchart TD\n  A --> B");
      const render = document.createElement("div");
      render.className = "nq-diagram-render";
      render.setAttribute("aria-live", "polite");
      const shell = document.createElement("div");
      shell.className = "nq-diagram";
      shell.append(source, render, ctx.children.element);
      const element = blockRow({ content: [shell], kind: "paragraph", actor: "human" });
      const draw = (mermaid: string): void => {
        if (mermaid.trim() === "") { render.textContent = ""; render.removeAttribute("data-error"); return; }
        try {
          peleMount(render, mermaid);
          render.removeAttribute("data-error");
        } catch (cause) {
          render.textContent = mermaid;
          render.setAttribute("data-error", cause instanceof Error ? cause.message : "diagram error");
        }
      };
      draw(source.value);
      return { element, update(block) { draw(block.text?.s ?? ""); }, destroy() { text.destroy(); } };
    },
  }],
});
