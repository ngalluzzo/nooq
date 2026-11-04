/** ProseMirror-backed text binding for arbitrary plugin blocks, scoped to one view. */
import { Schema, type Mark, type MarkSpec, type Node as PmNode } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { caretAfterChanges, replaceChanges, type JsonValue, type RenderedText, type TextChange } from "@nooq/core";
import type { MarkRenderer, RichTextBinding, RichTextOptions, TextMark } from "@nooq/plugins/dom";
import { baseOf, isToken, normalizeMarks } from "./mark-tokens.ts";
import { charDiff } from "./pm-surface.ts";

/** 0009 §3: the policy renderer contract is the plugins package's. */
export type { MarkRenderer } from "@nooq/plugins/dom";
/**
 * What a surface threads from a view's text policy beyond the base contract:
 * authoring marks become bases (a stored token matches by base), and each
 * contributed renderer becomes a mark type in this surface's schema.
 */
export type RichTextSurfaceOptions = Omit<RichTextOptions, "marks"> & { marks?: readonly string[]; renderMarks?: Readonly<Record<string, MarkRenderer>> };

// The bases whose PM marks carry no payload; every other base is payloaded (0009 §1/§2).
const bareMarkSpecs: Record<"strong" | "em" | "code" | "strike" | "underline" | "highlight", MarkSpec> = {
  strong: { toDOM: () => ["strong", 0], parseDOM: [{ tag: "strong" }, { tag: "b" }] },
  em: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }, { tag: "i" }] },
  // The code type class carries the mono face; the host theme adds the sunken ground.
  code: { toDOM: () => ["code", { class: "nq-code" }, 0], parseDOM: [{ tag: "code" }] },
  strike: { toDOM: () => ["del", 0], parseDOM: [{ tag: "del" }, { tag: "s" }] },
  underline: { toDOM: () => ["u", 0], parseDOM: [{ tag: "u" }] },
  // Highlight rides the pencil's soft wash — a fixed, themed color (no
  // per-character payload: that's the link mechanism's job, 0009 §1).
  highlight: { toDOM: () => ["mark", { class: "nq-highlight" }, 0], parseDOM: [{ tag: "mark" }] },
};

/** One payloaded base as a PM mark: the token rides an attribute, and toDOM hands the resolved payload to the renderer (0009 §3). */
function payloadedSpec(base: string, render: MarkRenderer): MarkSpec {
  return {
    // The covered text lands inside whatever element the renderer returns (PM
    // appends it); the empty string below is why the renderer's own text never
    // duplicates it. The host — never the renderer — carries the token, so DOM
    // round trips keep it (the same discipline as §8's data-nq-marks).
    attrs: { token: { default: "" }, payload: { default: undefined } },
    toDOM: (mark: Mark) => {
      const token = String(mark.attrs.token ?? "");
      const rendered = render(mark.attrs.payload as JsonValue | undefined, "");
      if (rendered instanceof Element) { rendered.setAttribute("data-nq-token", token); return rendered; }
      return ["span", { "data-nq-token": token }, 0]; // a renderer that broke its contract still preserves the token
    },
    parseDOM: [{ tag: "[data-nq-token]", getAttrs(dom: HTMLElement | string) {
      const token = typeof dom === "string" ? "" : dom.getAttribute("data-nq-token") ?? "";
      return isToken(token) && baseOf(token) === base ? { token } : false;
    } }],
  };
}

// An unfamiliar mark stays visible: the theme underlines it and the title names it (§8).
const opaqueSpec: MarkSpec = {
  attrs: { names: { default: [] }, titles: { default: [] as string[] } },
  toDOM: (mark: Mark) => ["span", { "data-nq-marks": JSON.stringify(mark.attrs.names), title: `Unrecognized formatting: ${((mark.attrs.titles as string[]).length ? mark.attrs.titles : mark.attrs.names as string[]).join(", ")}` }, 0],
  parseDOM: [{ tag: "span[data-nq-marks]", getAttrs(dom: HTMLElement | string) {
    if (typeof dom === "string") return false;
    try { const names: unknown = JSON.parse(dom.getAttribute("data-nq-marks")!); return Array.isArray(names) && names.every(n => typeof n === "string") ? { names } : false; } catch { return false; }
  } }],
};

/** One schema per renderMarks contribution set, so mounting N blocks builds it once. */
const schemaCache = new WeakMap<object, Schema>();
function schemaFor(renderMarks: Readonly<Record<string, MarkRenderer>>): Schema {
  const cached = schemaCache.get(renderMarks);
  if (cached) return cached;
  const payloaded = Object.keys(renderMarks).filter(base => !(base in bareMarkSpecs));
  const schema = new Schema({ nodes: { doc: { content: "text*", marks: "_", whitespace: "pre" }, text: {} }, marks: {
    ...bareMarkSpecs,
    ...Object.fromEntries(payloaded.map(base => [base, payloadedSpec(base, renderMarks[base]!)])),
    opaque: opaqueSpec,
  } });
  schemaCache.set(renderMarks, schema);
  return schema;
}

/** §8's courtesy (0009 §3): a token with a sibling fields entry names its meaning — "Link: https://nooq.dev", not "link:9f2c1a". */
function displayNameOf(mark: string, fields: Readonly<Record<string, JsonValue>>): string {
  const entry = fields[mark];
  if (entry === undefined) return mark;
  const label = baseOf(mark), capitalized = label.charAt(0).toUpperCase() + label.slice(1);
  return `${capitalized}: ${typeof entry === "string" ? entry : JSON.stringify(entry)}`;
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
  isComposing(): boolean;
  update(text: RenderedText, fields?: Readonly<Record<string, JsonValue>>): void;
  insertText(text: string): boolean;
}
export function mountRichText(host: {
  read(): RenderedText;
  /** The block's fields, so payloaded spans re-render when their entries change (0009 §1). */
  fields?(): Readonly<Record<string, JsonValue>>;
  commit(changes: TextChange[]): boolean;
  keyDown(event: KeyboardEvent): boolean;
  beforeInput?(event: InputEvent): boolean;
  input(text: string): void;
}, options: RichTextSurfaceOptions = {}): HostedRichText {
  const renderMarks = options.renderMarks ?? {};
  const schema = schemaFor(renderMarks);
  const allowed = new Set((options.marks ?? Object.keys(bareMarkSpecs)).map(mark => baseOf(mark)));
  // A base is authorable here only when this surface's schema can carry it; tokens match by base (0009 §2).
  const unsupported = [...allowed].find(base => !schema.marks[base]);
  if (unsupported !== undefined) throw new Error(`Unsupported rich text mark: ${unsupported}`);
  let fields: Readonly<Record<string, JsonValue>> = host.fields?.() ?? {};
  /** The payload each rendered token last showed (0009 §1). A changed entry re-renders only the spans carrying the token. */
  const renderedPayloads = new Map<string, string>();
  const payloadKey = (value: JsonValue | undefined): string => value === undefined ? "\u0000absent" : JSON.stringify(value);
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
  /** The empty-block placeholder rides a data attribute the theme turns into ::before text. */
  const syncEmpty = () => { element.toggleAttribute("data-nq-empty", state.doc.textContent === ""); };
  /** The stored names a PM node carries: tokens for payloaded bases, §8 names as stored. */
  function namesOf(node: PmNode): string[] {
    const names: string[] = [];
    for (const mark of node.marks) {
      if (mark.type.name === "opaque") names.push(...(mark.attrs.names as string[]));
      else if (renderMarks[mark.type.name]) { const token = String(mark.attrs.token ?? ""); if (token) names.push(token); }
      else names.push(mark.type.name);
    }
    return normalizeMarks(names);
  }
  function pmMarks(names: readonly string[]): Mark[] {
    const marks: Mark[] = [], unknown: { name: string; title: string }[] = [];
    for (const name of names) {
      if (isToken(name) && renderMarks[baseOf(name)] && schema.marks[baseOf(name)]) {
        const payload = fields[name];
        // A token without its payload is a partial state: it degrades to §8 — visible, preserved (0009 §1).
        if (payload !== undefined) { marks.push(schema.marks[baseOf(name)]!.create({ token: name, payload })); renderedPayloads.set(name, payloadKey(payload)); continue; }
      } else if (!isToken(name) && schema.marks[name] && !renderMarks[name]) {
        // A payloaded base never appears bare in stored marks (0009 §1); bare reserved bases are the only bare forms.
        marks.push(schema.marks[name]!.create()); continue;
      }
      unknown.push({ name, title: displayNameOf(name, fields) });
    }
    if (unknown.length) marks.push(schema.marks.opaque!.create({ names: unknown.map(entry => entry.name), titles: unknown.map(entry => entry.title) }));
    return marks;
  }
  function docOf(text: RenderedText): PmNode {
    const normalized = text.marks.map(marks => normalizeMarks(marks));
    const nodes: PmNode[] = [];
    for (let from = 0; from < text.s.length;) {
      let to = from + 1;
      while (to < text.s.length && JSON.stringify(normalized[to] ?? []) === JSON.stringify(normalized[from] ?? [])) to++;
      const names = normalized[from] ?? [];
      nodes.push(schema.text(text.s.slice(from, to), pmMarks(names))); from = to;
    }
    return schema.node("doc", null, nodes);
  }
  function textOf(doc: PmNode): RenderedText {
    const marks: string[][] = [];
    doc.forEach(node => {
      const names = namesOf(node);
      for (let i = 0; i < node.nodeSize; i++) marks.push([...names]);
    });
    return { s: doc.textContent, marks };
  }
  /** Tokens whose payloads no longer match what the rendered spans show — only those spans re-render (O(changed)). */
  function staleTokens(next: Readonly<Record<string, JsonValue>>): Set<string> {
    const stale = new Set<string>();
    for (const [key, value] of Object.entries(next)) {
      if (!isToken(key) || !renderMarks[baseOf(key)]) continue;
      if (renderedPayloads.get(key) !== payloadKey(value)) stale.add(key);
    }
    return stale;
  }
  function refreshStalePayloads(stale: Set<string>): void {
    if (!stale.size) return;
    let tr = state.tr, position = 0, touched = false;
    const affected: { start: number; end: number; names: string[] }[] = [];
    state.doc.forEach(node => {
      const names = namesOf(node);
      if (names.some(name => stale.has(name))) affected.push({ start: position, end: position + node.nodeSize, names });
      position += node.nodeSize;
    });
    for (const run of affected) {
      // Rebuild the run's marks from stored names against the new payloads: a
      // payload may flip §8 ⇄ rendered, or just change what toDOM resolves.
      tr = tr.removeMark(run.start, run.end);
      for (const mark of pmMarks(run.names)) tr = tr.addMark(run.start, run.end, mark);
      touched = true;
    }
    for (const token of stale) if (!affected.some(run => run.names.includes(token))) renderedPayloads.set(token, payloadKey(fields[token])); // orphaned: nothing to render, stop rescanning
    if (touched) updateState(state.apply(tr));
  }
  function update(text: RenderedText, nextFields: Readonly<Record<string, JsonValue>> = fields, force = false) {
    if (disposed) return;
    if (!force && (composing || view.composing)) { fields = nextFields; syncEmpty(); return; }
    const changes = richTextChanges(textOf(state.doc), { s: text.s, marks: text.marks.map(charMarks => normalizeMarks(charMarks)) });
    if (changes.length) {
      syncSelection();
      fields = nextFields;
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
    } else fields = nextFields;
    // Payloads sit in fields, not marks: a changed entry re-renders the spans
    // carrying its token even when the text and marks are byte-identical.
    refreshStalePayloads(staleTokens(fields));
    syncEmpty();
  }
  function dispatch(tr: Transaction): boolean {
    if (disposed) return false;
    const previousSelection = state.selection, previousMarks = state.storedMarks;
    const before = textOf(state.doc), next = state.apply(tr), after = textOf(next.doc);
    const changes = richTextChanges(before, after);
    updateState(next);
    let accepted = true;
    if (changes.length) accepted = host.commit(rebaseTextChanges(changes, before.s, host.read().s));
    const admitted = host.read();
    update(admitted, host.fields?.(), !accepted);
    if (!accepted) {
      // A replacement collapses PM's selection before authorization. Restore the
      // original range after rollback, mapped through any already-admitted drift.
      const remote = replaceChanges(before.s, admitted.s);
      const offset = (position: number) => Math.min(state.doc.content.size, Math.max(0, caretAfterChanges(remote, position)));
      updateState(state.apply(state.tr.setSelection(TextSelection.create(state.doc,
        offset(previousSelection.anchor), offset(previousSelection.head))).setStoredMarks(previousMarks)));
    }
    if (accepted && changes.length && !composing) host.input(host.read().s);
    return accepted;
  }
  function toggleMark(name: TextMark): boolean {
    // Payloaded bases apply through their command, not toggling: a mark with no token is not a legal stored form (0009 §1).
    if (disposed || composing || view.composing || renderMarks[name] || !schema.marks[name]) return false;
    // The policy admits bases; a stored token matches by base (0009 §2).
    if (!allowed.has(baseOf(name))) return false;
    syncSelection();
    const type = schema.marks[name]!, { from, to, empty } = state.selection;
    if (empty) {
      const marks = state.storedMarks ?? state.selection.$from.marks();
      return dispatch(type.isInSet(marks) ? state.tr.removeStoredMark(type) : state.tr.addStoredMark(type.create()));
    }
    return dispatch(state.doc.rangeHasMark(from, to, type) ? state.tr.removeMark(from, to, type) : state.tr.addMark(from, to, type.create()));
  }
  function insertText(text: string): boolean {
    if (disposed || composing || view.composing) return false;
    syncSelection(); return dispatch(state.tr.insertText(text));
  }
  view = new EditorView({ mount: element }, {
    state, dispatchTransaction: tr => { dispatch(tr); },
    // nq-doc-body types the host like the plain textarea; the inline styles are
    // behavior (whitespace and minimum height), not theme.
    attributes: { class: "nq-input nq-rich-text nq-doc-body", role: "textbox", "aria-label": options.label ?? "Text block", "aria-multiline": "true", style: "white-space:pre-wrap;overflow-wrap:anywhere;min-height:2em" },
    handleKeyDown(_view, event) {
      if (composing || event.isComposing || view.composing) return false;
      if (host.keyDown(event)) return true;
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const chord = `${event.shiftKey ? "Shift+" : ""}${event.key.toLowerCase()}` as string;
        const mark = ({ b: "strong", i: "em", "`": "code", "Shift+x": "strike", "Shift+u": "underline", "Shift+h": "highlight" } as const)[chord];
        // Consume known formatting shortcuts even when disallowed: browser defaults
        // must not introduce formatting outside this binding's authoring policy.
        if (mark) { toggleMark(mark); return true; }
      }
      if (event.key === "Enter") { insertText("\n"); return true; }
      return false;
    },
    handlePaste(_view, _event, slice) {
      // Hosts can handle rich clipboard content before this inline fallback.
      dispatch(state.tr.insertText(slice.content.textBetween(0, slice.content.size, "\n"))); return true;
    },
    handleDOMEvents: {
      beforeinput(_view, event) {
        const input = event as InputEvent;
        if (!input.cancelable || composing || input.isComposing || view.composing) return false;
        if (host.beforeInput?.(input)) { input.preventDefault(); return true; }
        if (input.inputType === "insertParagraph" || input.inputType === "insertLineBreak") {
          input.preventDefault(); insertText("\n"); return true;
        }
        const mark = ({ formatBold: "strong", formatItalic: "em" } as const)[input.inputType as "formatBold" | "formatItalic"];
        if (mark) { input.preventDefault(); toggleMark(mark); return true; }
        return false;
      },
      compositionstart() { composing = true; if (finishing) clearTimeout(finishing); return false; },
      compositionend() {
        // Allow PM's DOM observer to consume the final native input first.
        finishing = setTimeout(() => { composing = false; if (!disposed) { update(host.read(), host.fields?.(), true); host.input(host.read().s); } }, 30);
        return false;
      },
    },
  });
  element.toggleAttribute("data-nq-empty", state.doc.textContent === "");
  return { element, update, insertText, isComposing: () => composing || view.composing,
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
