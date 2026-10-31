/** Trusted preview host. Candidate code runs only inside the browser frame. */
import * as Y from "yjs";
import { Editor, createSurface } from "@nooq/editor";
import type { Plugin } from "@nooq/plugins";
import type { DOMPlugin } from "@nooq/plugins/dom";
import type { Brief } from "./brief.ts";

export function mountPreview(plugin: Plugin, dom: DOMPlugin, brief: Brief) {
  let mounts = 0, destroys = 0;
  const observed: DOMPlugin = { ...dom, views: dom.views.map(view => ({ ...view, mount(ctx) {
    mounts++; const instance = view.mount(ctx);
    return { ...instance, destroy() { destroys++; instance.destroy?.(); } };
  } })) };
  const a = new Editor({ docId: "generated-preview", actor: { actorId: "human:author" }, plugins: [plugin] });
  const b = new Editor({ docId: a.docId, actor: { actorId: "human:peer" } });
  const left = createSurface(a, { plugins: [observed] }), right = createSurface(b);
  document.querySelector("#author")!.append(left.element); document.querySelector("#peer")!.append(right.element);
  const sync = () => Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc)); a.onChange(sync);
  const inserted = a.commands.run(brief.insertCommand!.id, { parent: null });
  if (inserted.status !== "applied" || !inserted.selection) throw new Error("Insertion command must return selection of its inserted block");
  const target = inserted.selection.block;
  a.editText(target, "Write a note. Your peer sees the same content without installing this plugin.");
  a.setField(target, "futureField", { preserved: true });
  const child = a.insertBlock({ type: "unknown.child/v1", parent: target, text: "Nested child" });
  const source = a.insertBlock({ type: "unknown.paragraph/v1", parent: null, text: "" });
  const reset = document.querySelector<HTMLButtonElement>("#reset")!; reset.onclick = () => location.reload();
  document.querySelector<HTMLButtonElement>("#remote")!.onclick = () => { b.applyTextChanges(target, [{ insert: "Peer: " }]); Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc)); };
  return { a, b, target, child, source, left, right,
    counts: () => ({ mounts, destroys }),
    remote: () => { b.applyTextChanges(target, [{ insert: "++" }]); Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc)); },
    close: () => { a.close(); b.close(); },
  };
}
