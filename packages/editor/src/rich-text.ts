/** ProseMirror-backed text binding for arbitrary plugin blocks, scoped to one view. */
import { Schema, type Mark, type Node as PmNode } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { caretAfterChanges, replaceChanges, type RenderedText, type TextChange } from "@nooq/core";
import type { RichTextBinding, RichTextOptions, TextMark } from "@nooq/plugins/dom";
import { charDiff } from "./pm-surface.ts";

const schema = new Schema({ nodes: { doc: { content: "text*", marks: "_" }, text: {} }, marks: {
  strong: { toDOM: () => ["strong", 0], parseDOM: [{ tag: "strong" }, { tag: "b" }] },
  em: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }, { tag: "i" }] },
  code: { toDOM: () => ["code", 0], parseDOM: [{ tag: "code" }] },
  // An unfamiliar mark remains part of the projection even though we cannot style it.
  opaque: { attrs: { names: {} }, toDOM: mark => ["span", { "data-nq-marks": JSON.stringify(mark.attrs.names) }, 0],
    parseDOM: [{ tag: "span[data-nq-marks]", getAttrs(dom) {
      try { const names: unknown = JSON.parse(dom.getAttribute("data-nq-marks")!); return Array.isArray(names) && names.every(n => typeof n === "string") ? { names } : false; } catch { return false; }
    } }],
  },
} });

const known = new Set<string>(["strong", "em", "code"]);
function pmMarks(names: readonly string[]): Mark[] {
  const unknown = names.filter(name => !known.has(name));
  return [...names.filter(name => known.has(name)).map(name => schema.marks[name]!.create()), ...(unknown.length ? [schema.marks.opaque!.create({ names: unknown })] : [])];
}
function docOf(text: RenderedText): PmNode {
  const nodes: PmNode[] = [];
  for (let from = 0; from < text.s.length;) {
    let to = from + 1;
    while (to < text.s.length && JSON.stringify(text.marks[from] ?? []) === JSON.stringify(text.marks[to] ?? [])) to++;
    nodes.push(schema.text(text.s.slice(from, to), pmMarks(text.marks[from] ?? []))); from = to;
  }
  return schema.node("doc", null, nodes);
}
function textOf(doc: PmNode): RenderedText {
  const marks: string[][] = [];
  doc.forEach(node => {
    const names = [...new Set(node.marks.flatMap(mark => mark.type.name === "opaque" ? mark.attrs.names as string[] : [mark.type.name]))].sort();
    for (let i = 0; i < node.nodeSize; i++) marks.push([...names]);
  });
  return { s: doc.textContent, marks };
}
export function richTextChanges(before: RenderedText, after: RenderedText): TextChange[] {
  return charDiff({ text: before.s, charMarks: before.marks }, { text: after.s, charMarks: after.marks });
}

/** Map deferred composition edits onto the currently admitted text. */
export function rebaseTextChanges(changes: readonly TextChange[], before: string, current: string): TextChange[] {
  if (before === current) return [...changes];
  const remote = replaceChanges(before, current), out: TextChange[] = [];
  let base = 0, cursor = 0;
  const advance = (position: number) => { if (position > cursor) out.push({ retain: position - cursor }); cursor = position; };
  for (const change of changes) {
    if ("retain" in change && !("setMarks" in change)) { base += change.retain; continue; }
    const start = caretAfterChanges(remote, base);
    advance(Math.max(cursor, start));
    if ("insert" in change) out.push(change);
    else {
      const length = "delete" in change ? change.delete : change.retain;
      const end = Math.max(cursor, caretAfterChanges(remote, base + length));
      if (end > cursor) out.push("delete" in change ? { delete: end - cursor } : { retain: end - cursor, setMarks: change.setMarks });
      cursor = end; base += length;
    }
  }
  return out;
}

export interface HostedRichText extends RichTextBinding {
  update(text: RenderedText): void;
}
export function mountRichText(host: {
  read(): RenderedText;
  commit(changes: TextChange[]): boolean;
  keyDown(event: KeyboardEvent): boolean;
  input(text: string): void;
}, options: RichTextOptions = {}): HostedRichText {
  const allowed = new Set(options.marks ?? ["strong", "em", "code"]);
  if ([...allowed].some(mark => !known.has(mark))) throw new Error("Unsupported rich text mark");
  let disposed = false, composing = false, finishing: ReturnType<typeof setTimeout> | undefined;
  let state = EditorState.create({ schema, doc: docOf(host.read()) });
  const element = document.createElement("div");
  let view: EditorView;
  const updateState = (next: EditorState) => { state = next; view.updateState(next); };
  function syncSelection() {
    // selectionchange is asynchronous. A remote patch or toolbar action may arrive first.
    const selection = element.ownerDocument.getSelection();
    if (!view.hasFocus() || !selection?.anchorNode || !selection.focusNode || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return;
    try {
      const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset), head = view.posAtDOM(selection.focusNode, selection.focusOffset);
      if (anchor !== state.selection.anchor || head !== state.selection.head) updateState(state.apply(state.tr.setSelection(TextSelection.create(state.doc, anchor, head))));
    } catch { /* During native composition the DOM may be ahead of its projection. */ }
  }
  function update(text: RenderedText, force = false) {
    if (disposed || (!force && (composing || view.composing))) return;
    const changes = richTextChanges(textOf(state.doc), text);
    if (!changes.length) return;
    syncSelection();
    let tr = state.tr, position = 0;
    for (const change of changes) {
      if ("insert" in change) { tr = tr.insert(position, schema.text(change.insert, pmMarks(change.marks ?? []))); position += change.insert.length; }
      else if ("delete" in change) tr = tr.delete(position, position + change.delete);
      else {
        if ("setMarks" in change) {
          tr = tr.removeMark(position, position + change.retain);
          for (const mark of pmMarks(change.setMarks ?? [])) tr = tr.addMark(position, position + change.retain, mark);
        }
        position += change.retain;
      }
    }
    updateState(state.apply(tr));
  }
  function dispatch(tr: Transaction): boolean {
    if (disposed) return false;
    const before = textOf(state.doc), next = state.apply(tr), after = textOf(next.doc);
    const changes = richTextChanges(before, after);
    updateState(next);
    let accepted = true;
    if (changes.length) accepted = host.commit(rebaseTextChanges(changes, before.s, host.read().s));
    update(host.read(), !accepted);
    if (accepted && changes.length && !composing) host.input(host.read().s);
    return accepted;
  }
  function toggleMark(name: TextMark): boolean {
    if (disposed || !allowed.has(name) || composing || view.composing) return false;
    syncSelection();
    const type = schema.marks[name]!, { from, to, empty } = state.selection;
    if (empty) {
      const marks = state.storedMarks ?? state.selection.$from.marks();
      return dispatch(type.isInSet(marks) ? state.tr.removeStoredMark(type) : state.tr.addStoredMark(type.create()));
    }
    return dispatch(state.doc.rangeHasMark(from, to, type) ? state.tr.removeMark(from, to, type) : state.tr.addMark(from, to, type.create()));
  }
  view = new EditorView({ mount: element }, {
    state, dispatchTransaction: tr => { dispatch(tr); },
    attributes: { class: "nq-input nq-rich-text", role: "textbox", "aria-label": options.label ?? "Text block", "aria-multiline": "true", style: "white-space:pre-wrap;overflow-wrap:anywhere;min-height:2em" },
    handleKeyDown(_view, event) {
      if (composing || event.isComposing || view.composing) return false;
      if (host.keyDown(event)) return true;
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const mark = ({ b: "strong", i: "em", "`": "code" } as const)[event.key.toLowerCase() as "b" | "i" | "`"];
        if (mark && allowed.has(mark)) { toggleMark(mark); return true; }
      }
      if (event.key === "Enter") { dispatch(state.tr.insertText("\n")); return true; }
      return false;
    },
    handlePaste(_view, _event, slice) {
      // This binding has one inline text flow. Multi-block import is a later host service.
      dispatch(state.tr.insertText(slice.content.textBetween(0, slice.content.size, "\n"))); return true;
    },
    handleDOMEvents: {
      compositionstart() { composing = true; if (finishing) clearTimeout(finishing); return false; },
      compositionend() {
        // Allow PM's DOM observer to consume the final native input first.
        finishing = setTimeout(() => { composing = false; if (!disposed) { update(host.read(), true); host.input(host.read().s); } }, 30);
        return false;
      },
    },
  });
  return { element, update,
    selection: () => { if (!disposed && !composing) syncSelection(); return { anchor: state.selection.anchor, head: state.selection.head }; },
    focus(selection) {
      if (disposed) return;
      if (selection) {
        const bound = (n: number) => Math.max(0, Math.min(state.doc.content.size, Number.isFinite(n) ? Math.trunc(n) : 0));
        updateState(state.apply(state.tr.setSelection(TextSelection.create(state.doc, bound(selection.anchor), bound(selection.head)))));
      }
      view.focus();
    }, toggleMark,
    destroy() { if (disposed) return; disposed = true; if (finishing) clearTimeout(finishing); view.destroy(); },
  };
}
