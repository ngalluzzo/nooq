import { caretAfterChanges, replaceChanges, type Block, type DocState, type TextChange } from "@nooq/core";
import { planTextMerge, resolveTextRange, textBlockOrder, type CommandResult, type DocumentTextSelection, type TextPoint } from "@nooq/plugins";
import type { DocumentSelectionService, TextMark, TextSelection } from "@nooq/plugins/dom";
import type { Editor } from "./controller.ts";

export interface SelectionBinding {
  element: HTMLElement;
  /** null is a legacy textarea, which forms a document-selection barrier. Rich bindings carry their policy's authoring bases (0009 §2). */
  marks: readonly string[] | null;
  selection(): TextSelection;
  focus(selection?: TextSelection): void;
  update(block: Block): void;
}
const declined = (): CommandResult => ({ status: "not-applicable" });
const cross = (range: DocumentTextSelection) => range.anchor.block !== range.head.block;
const clone = (range: DocumentTextSelection): DocumentTextSelection => ({ anchor: { ...range.anchor }, head: { ...range.head } });

/** Coordinates native ranges across independent plugin text hosts. Never edits plugin DOM. */
export function createDocumentSelection(editor: Editor, root: HTMLElement, bindings: () => Map<string, SelectionBinding>, blocked: () => boolean) {
  const doc = root.ownerDocument, abort = new AbortController();
  let disposed = false, painting = false, rendered = editor.view;
  let tracked: { range: DocumentTextSelection; ids: string[]; texts: Map<string, string> } | undefined;
  let drag: { anchor: TextPoint; extended: boolean } | undefined;
  const supported = (range: DocumentTextSelection, snapshot = editor.view) => {
    const parts = resolveTextRange(snapshot, range), entries = bindings();
    if (!parts?.every(part => entries.get(part.block)?.marks !== null && entries.has(part.block))) return;
    // Native order must agree with model order. A custom view may place its child slot first.
    for (let i = 1; i < parts.length; i++) if (!(entries.get(parts[i - 1]!.block)!.element.compareDocumentPosition(entries.get(parts[i]!.block)!.element) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
    return parts;
  };
  function remember(range: DocumentTextSelection, snapshot = editor.view): boolean {
    const parts = supported(range, snapshot); if (!parts) return false;
    tracked = { range: clone(range), ids: parts.map(p => p.block), texts: new Map(parts.map(p => [p.block, snapshot.blocks[p.block]!.text!.s])) };
    return true;
  }
  function clear() {
    tracked = undefined;
    const native = doc.getSelection();
    if (native?.anchorNode && native.focusNode && root.contains(native.anchorNode) && root.contains(native.focusNode)) native.removeAllRanges();
  }
  function refresh() {
    if (!tracked || disposed) return;
    const snapshot = editor.view, old = tracked;
    const map = (point: TextPoint): TextPoint | undefined => {
      const text = snapshot.blocks[point.block]?.text?.s, before = old.texts.get(point.block);
      if (text === undefined || before === undefined) return;
      return { block: point.block, offset: Math.min(text.length, caretAfterChanges(replaceChanges(before, text), point.offset)) };
    };
    const anchor = map(old.range.anchor), head = map(old.range.head);
    const parts = anchor && head ? supported({ anchor, head }, snapshot) : undefined;
    // A changed span membership (deletion, move, insertion within it) cancels rather
    // than silently selecting content the writer did not select. Outside edits are safe.
    if (!parts || parts.map(p => p.block).join("\0") !== old.ids.join("\0")) { clear(); return; }
    remember({ anchor: anchor!, head: head! }, snapshot);
  }
  function fromDOM(node: Node | null, offset: number): TextPoint | undefined {
    if (!node) return;
    for (const [block, binding] of bindings()) {
      if (binding.marks === null || !binding.element.contains(node)) continue;
      try {
        const range = doc.createRange(); range.selectNodeContents(binding.element); range.setEnd(node, offset);
        return { block, offset: range.toString().length };
      } catch { return; }
    }
  }
  function capture() {
    if (disposed || painting) return;
    if (!root.contains(doc.activeElement)) { tracked = undefined; return; }
    const native = doc.getSelection(), anchor = fromDOM(native?.anchorNode ?? null, native?.anchorOffset ?? 0), head = fromDOM(native?.focusNode ?? null, native?.focusOffset ?? 0);
    if (anchor && head) {
      if (tracked && anchor.block === tracked.range.anchor.block && anchor.offset === tracked.range.anchor.offset
        && head.block === tracked.range.head.block && head.offset === tracked.range.head.offset) return;
      remember({ anchor, head }, rendered);
    }
    else if (!root.contains(doc.activeElement)) tracked = undefined;
  }
  function pointDOM(point: TextPoint): [Node, number] | undefined {
    const element = bindings().get(point.block)?.element; if (!element) return;
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT); let remaining = point.offset, node = walker.nextNode();
    while (node) { if (remaining <= node.textContent!.length) return [node, remaining]; remaining -= node.textContent!.length; node = walker.nextNode(); }
    return remaining === 0 ? [element, element.childNodes.length] : undefined;
  }
  function paint(focus: boolean) {
    if (!tracked || disposed) return;
    painting = true;
    try {
      const { anchor, head } = tracked.range, entries = bindings();
      for (const id of tracked.ids) entries.get(id)?.update(editor.view.blocks[id]!);
      if (!cross(tracked.range)) {
        if (focus) entries.get(anchor.block)?.focus({ anchor: anchor.offset, head: head.offset });
        return;
      }
      if (focus) root.focus({ preventScroll: true });
      const a = pointDOM(anchor), h = pointDOM(head);
      const native = doc.getSelection();
      if (a && h && native && (native.anchorNode !== a[0] || native.anchorOffset !== a[1] || native.focusNode !== h[0] || native.focusOffset !== h[1])) native.setBaseAndExtent(...a, ...h);
    } finally { painting = false; }
  }
  function get(): DocumentTextSelection | undefined {
    if (disposed) return;
    if (!root.contains(doc.activeElement)) { tracked = undefined; return; }
    if (!tracked || !cross(tracked.range)) capture();
    refresh(); return tracked ? clone(tracked.range) : undefined;
  }
  function set(range: DocumentTextSelection): boolean {
    if (disposed || blocked()) return false;
    if (!remember(range)) { clear(); return false; }
    paint(true); return true;
  }
  function text() {
    const range = get(), parts = range && supported(range);
    return parts?.map(p => editor.view.blocks[p.block]!.text!.s.slice(p.from, p.to)).join("\n") ?? "";
  }
  function edit(args: { block: string; changes: TextChange[] }[]): CommandResult {
    if (!args.length || disposed || blocked()) return declined();
    const result = editor.commands.batch("nooq.text.edit", args);
    if (result.status === "failed") editor.reportError({ phase: "view", cause: result.error });
    else if (result.status === "denied") editor.reportError({ phase: "view", cause: new Error(result.reason) });
    return result;
  }
  function mergeRange(range: DocumentTextSelection, value: string): CommandResult {
    if (disposed || blocked() || !supported(range) || !editor.registry.command("nooq.text.merge")) return declined();
    const result = editor.commands.run("nooq.text.merge", { range, text: value });
    if (result.status === "applied") {
      // A custom merge provider owns its selection. Do not reuse endpoints of deleted blocks.
      tracked = undefined;
      if (result.selection) {
        const s = result.selection; set({ anchor: { block: s.block, offset: s.anchor }, head: { block: s.block, offset: s.head } });
      } else clear();
    } else {
      if (result.status === "failed") editor.reportError({ phase: "view", cause: result.error });
      if (result.status === "denied") editor.reportError({ phase: "view", cause: new Error(result.reason) });
      paint(false);
    }
    return result;
  }
  function merge(value = ""): CommandResult {
    const range = get(); return range && typeof value === "string" ? mergeRange(range, value) : declined();
  }
  function replace(value: string): CommandResult {
    if (typeof value !== "string") return declined();
    const range = get(), parts = range && supported(range); if (!parts) return declined();
    if (editor.registry.command("nooq.text.merge") && planTextMerge(editor.view, range!, value, type => editor.registry.block(type)?.definition)) return mergeRange(range!, value);
    const args = parts.flatMap((p, index) => p.from !== p.to || (index === 0 && value.length) ? [{ block: p.block,
      changes: [{ retain: p.from }, { delete: p.to - p.from }, ...(index === 0 && value.length ? [{ insert: value, marks: [] }] : [])] as TextChange[],
    }] : []);
    const result = edit(args);
    if (result.status === "applied") {
      const requested = result.selection;
      if (requested) set({ anchor: { block: requested.block, offset: requested.anchor }, head: { block: requested.block, offset: requested.head } });
      else { const point = { block: parts[0]!.block, offset: parts[0]!.from + value.length }; set({ anchor: point, head: point }); }
    } else paint(false);
    return result;
  }
  function toggleMark(mark: TextMark): CommandResult {
    const range = get(), parts = range && supported(range), entries = bindings();
    if (!parts || !parts.every(p => entries.get(p.block)?.marks?.includes(mark))) return declined();
    const snapshot = editor.view, chars = parts.flatMap(p => snapshot.blocks[p.block]!.text!.marks.slice(p.from, p.to));
    if (!chars.length) return declined();
    const remove = chars.every(names => names.includes(mark));
    const args = parts.filter(p => p.to > p.from).map(p => ({ block: p.block,
      changes: [{ retain: p.from }, ...Array.from({ length: p.to - p.from }, (_, i) => ({ retain: 1,
        setMarks: remove ? snapshot.blocks[p.block]!.text!.marks[p.from + i]!.filter(n => n !== mark)
          : [...new Set([...snapshot.blocks[p.block]!.text!.marks[p.from + i]!, mark])].sort(),
      }))],
    }));
    const result = edit(args);
    if (result.status === "applied" && result.selection) {
      const requested = result.selection; set({ anchor: { block: requested.block, offset: requested.anchor }, head: { block: requested.block, offset: requested.head } });
    } else if (tracked) paint(false);
    return result;
  }
  const service: DocumentSelectionService = { get, set, clear, text, replace, merge, toggleMark };
  const handled = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
  const isTextTarget = (target: EventTarget | null) => target === root || [...bindings().values()].some(b => b.marks !== null && target instanceof Node && b.element.contains(target));
  const edge = (end: boolean): TextPoint | undefined => {
    const order = textBlockOrder(editor.view), block = end ? order.at(-1) : order[0];
    return block ? { block, offset: end ? editor.view.blocks[block]!.text!.s.length : 0 } : undefined;
  };
  function move(point: TextPoint, direction: -1 | 1): TextPoint | undefined {
    const text = editor.view.blocks[point.block]?.text?.s; if (text === undefined) return;
    const boundaries = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(s => s.index); boundaries.push(text.length);
    const offset = direction < 0 ? boundaries.filter(n => n < point.offset).at(-1) : boundaries.find(n => n > point.offset);
    if (offset !== undefined) return { block: point.block, offset };
    const order = textBlockOrder(editor.view), block = order[order.indexOf(point.block) + direction];
    return block ? { block, offset: direction < 0 ? editor.view.blocks[block]!.text!.s.length : 0 } : undefined;
  }
  function boundaryDelete(range: DocumentTextSelection, direction: -1 | 1): boolean {
    if (cross(range) || range.anchor.offset !== range.head.offset) return false;
    const point = range.head, length = editor.view.blocks[point.block]?.text?.s.length;
    if (point.offset !== (direction < 0 ? 0 : length)) return false;
    const neighbor = move(point, direction);
    if (neighbor && neighbor.block !== point.block) mergeRange({ anchor: point, head: neighbor }, "");
    // At an incompatible boundary do not let a legacy empty-block shortcut delete a subtree.
    return true;
  }
  root.addEventListener("keydown", event => {
    if (event.isComposing || !isTextTarget(event.target) || blocked()) return;
    const range = get(); if (!range) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && event.key.toLowerCase() === "a") {
      const anchor = edge(false), head = edge(true); if (anchor && head) set({ anchor, head }); handled(event); return;
    }
    if (event.shiftKey && !event.altKey && ((!mod && ["ArrowLeft", "ArrowRight"].includes(event.key)) || (mod && ["Home", "End"].includes(event.key)))) {
      const head = mod ? edge(event.key === "End") : move(range.head, event.key === "ArrowLeft" ? -1 : 1);
      if (head && (cross(range) || head.block !== range.anchor.block) && set({ anchor: range.anchor, head })) handled(event);
      return;
    }
    if (!event.shiftKey && !mod && !event.altKey && ["Backspace", "Delete"].includes(event.key) && boundaryDelete(range, event.key === "Backspace" ? -1 : 1)) { handled(event); return; }
    if (!cross(range)) return;
    if (!event.shiftKey && !mod && ["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) {
      const parts = supported(range)!; const p = event.key === "ArrowRight" ? parts.at(-1)! : parts[0]!;
      const point = { block: p.block, offset: event.key === "ArrowRight" ? p.to : p.from }; set({ anchor: point, head: point }); handled(event); return;
    }
    if (mod && !event.altKey) {
      const mark = ({ b: "strong", i: "em", "`": "code" } as const)[event.key.toLowerCase() as "b" | "i" | "`"];
      if (mark) { toggleMark(mark); handled(event); } return;
    }
    if (!event.altKey && (Array.from(event.key).length === 1 || ["Backspace", "Delete", "Enter"].includes(event.key))) {
      replace(event.key === "Enter" ? "\n" : ["Backspace", "Delete"].includes(event.key) ? "" : event.key); handled(event);
    }
  }, { capture: true, signal: abort.signal });
  root.addEventListener("beforeinput", event => {
    const input = event as InputEvent, range = get();
    if (!range || !input.cancelable || !isTextTarget(input.target) || blocked()) return;
    if (!input.isComposing && ["deleteContentBackward", "deleteContentForward"].includes(input.inputType) && boundaryDelete(range, input.inputType === "deleteContentBackward" ? -1 : 1)) { handled(input); return; }
    if (!cross(range)) return;
    handled(input);
    if (input.isComposing) return; // A range is never partially edited by a composing block binding.
    if (input.inputType === "insertText" && input.data !== null) replace(input.data);
    else if (["deleteContentBackward", "deleteContentForward", "deleteByCut"].includes(input.inputType)) replace("");
    else if (["insertParagraph", "insertLineBreak"].includes(input.inputType)) replace("\n");
  }, { capture: true, signal: abort.signal });
  for (const type of ["copy", "cut", "paste"] as const) root.addEventListener(type, event => {
    const range = get(); if (!range || !cross(range) || !isTextTarget(event.target)) return;
    handled(event); if (!event.clipboardData) return;
    if (type === "paste") {
      const plain = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
      if (plain) replace(plain);
    }
    else { event.clipboardData.setData("text/plain", text()); if (type === "cut") replace(""); }
  }, { capture: true, signal: abort.signal });
  for (const type of ["dragstart", "drop"] as const) root.addEventListener(type, event => {
    const range = get(); if (range && cross(range)) handled(event);
  }, { capture: true, signal: abort.signal });
  function atPointer(event: MouseEvent): TextPoint | undefined {
    const document = doc as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null; caretRangeFromPoint?(x: number, y: number): Range | null };
    const point = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (point) return fromDOM(point.offsetNode, point.offset);
    const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    return range ? fromDOM(range.startContainer, range.startOffset) : undefined;
  }
  root.addEventListener("mousedown", event => {
    if (event.button !== 0 || !isTextTarget(event.target)) return;
    const point = atPointer(event); if (!point) return;
    const previous = get();
    if (event.shiftKey && previous && set({ anchor: previous.anchor, head: point })) { handled(event); return; }
    tracked = undefined; drag = { anchor: point, extended: false };
  }, { capture: true, signal: abort.signal });
  doc.addEventListener("mousemove", event => {
    if (!drag || !(event.buttons & 1)) return;
    const point = atPointer(event); if (!point || (!drag.extended && point.block === drag.anchor.block)) return;
    if (set({ anchor: drag.anchor, head: point })) { drag.extended = true; event.preventDefault(); }
  }, { capture: true, signal: abort.signal });
  doc.addEventListener("mouseup", () => { if (drag?.extended) paint(true); drag = undefined; }, { signal: abort.signal });
  doc.addEventListener("selectionchange", () => {
    if (painting || drag?.extended) return;
    capture(); refresh();
    if (tracked && cross(tracked.range) && isTextTarget(doc.activeElement)) paint(true);
  }, { signal: abort.signal });
  return { service,
    beforeRender() { if (!tracked || !cross(tracked.range)) capture(); refresh(); },
    afterRender() { rendered = editor.view; if (tracked && cross(tracked.range) && root.contains(doc.activeElement)) paint(false); },
    destroy() { disposed = true; abort.abort(); clear(); drag = undefined; },
  };
}
