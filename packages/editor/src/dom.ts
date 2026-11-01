/** Plugin-driven surface: views own their content; the host owns text and children. */
import { caretAfterChanges, liveTree, replaceChanges, type Block, type DocState, type TextChange } from "@nooq/core";
import { freezeInPlace, freezeSnapshot, type Immutable, type SelectionRequest } from "@nooq/plugins";
import { defineTextPolicy, type Action, type DocumentSelectionService, type TextMark, type BlockView, type BlockViewContext, type DOMPlugin, type RichTextOptions, type SurfaceAction, type SurfaceActionContext, type SurfaceActions, type TextBinding, type TextEditorBinding, type TextMode, type TextPolicy, type TextSelection } from "@nooq/plugins/dom";
import { presenceCaret, slashMenu, syncStatus } from "@nooq/design";
import type { Editor } from "./controller.ts";
import { mountRichText as createRichText } from "./rich-text.ts";
import { createActions, mountActionToolbar } from "./actions.ts";
import { createDocumentSelection } from "./document-selection.ts";

export interface EditorSurface {
  element: HTMLElement;
  actions: SurfaceActions;
  /** Present only when selectionMode is document. */
  selection?: DocumentSelectionService;
  destroy(): void;
  /** EB-7 observability: remote renders seen, viewport pins applied. */
  readonly remoteRenders: number;
  readonly pins: number;
  readonly lastAnchor: string | null;
  readonly lastDrift: number;
  readonly lastAnchorRect: { top: number; bottom: number } | null;
  readonly lastViewportTop: number;
  readonly renderCounts: { targeted: number; full: number; presence: number };
}
export interface SurfaceOptions {
  plugins?: readonly DOMPlugin[];
  resolve?: Readonly<Record<string, string>>;
  keyOrder?: Readonly<Record<string, readonly string[]>>;
  /** Overrides presentation for mountTextEditor views; explicit legacy bindings stay explicit. */
  textMode?: TextMode;
  /** Opt in to cross-block rich-text selection; requires textMode: rich and nooq.text.edit. */
  selectionMode?: "block" | "document";
}
interface Binding { marks?: readonly TextMark[]; element: HTMLElement; update(block: Block): void; selection(): TextSelection; focus(selection?: TextSelection): void; insertText(text: string): boolean; destroy(): void }
type ViewProvider = { plugin: string; mount: DOMPlugin["views"][number]["mount"]; textPolicy?: TextPolicy };
const defaultTextPolicy = defineTextPolicy();
interface Row {
  id: string;
  shell: HTMLElement; children: HTMLElement; presence: HTMLElement; view: BlockView;
  abort: AbortController; bindings: Binding[]; cleanups: (() => void)[]; signature: string; type: string;
}

export function createSurface(editor: Editor, options: SurfaceOptions = {}): EditorSurface {
  if (options.textMode !== undefined && options.textMode !== "plain" && options.textMode !== "rich") throw new Error("Invalid surface text mode");
  if (options.selectionMode !== undefined && !["block", "document"].includes(options.selectionMode)) throw new Error("Invalid selection mode");
  if (options.selectionMode === "document" && (options.textMode !== "rich" || !editor.registry.command("nooq.text.edit"))) throw new Error("Document selection requires textMode: rich and a registered nooq.text.edit command");
  const textMode = options.textMode;
  const plugins = options.plugins ?? [], views = new Map<string, ViewProvider>();
  const providers = new Map<string, ViewProvider[]>();
  const seen = new Set<string>(), menus: SurfaceAction[] = [];
  const definitions: Action[] = [], legacyIds = new Set(plugins.flatMap(p => [...p.menus ?? [], ...p.keys ?? []].map(a => a.id)));
  const keys = new Map<string, NonNullable<DOMPlugin["keys"]>[number][]>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) throw new Error(`Duplicate DOM plugin ${plugin.id}`);
    seen.add(plugin.id);
    if (!editor.registry.plugins.some(p => p.id === plugin.forPlugin.id && p.version === plugin.forPlugin.version)) throw new Error(`DOM plugin ${plugin.id} requires ${plugin.forPlugin.id}@${plugin.forPlugin.version}`);
    for (const view of plugin.views) {
      const block = editor.registry.block(view.type);
      if (!block) throw new Error(`View ${plugin.id} references unknown block ${view.type}`);
      const policy = view.textPolicy ? defineTextPolicy(view.textPolicy) : undefined;
      if (policy && block.definition.text !== "inline") throw new Error(`Text policy requires an inline block: ${view.type}`);
      if (policy?.enter && policy.enter !== "newline" && !editor.registry.command(policy.enter.command)) throw new Error(`Unknown Enter command ${policy.enter.command}`);
      providers.set(view.type, [...providers.get(view.type) ?? [], { plugin: plugin.id, mount: view.mount, textPolicy: policy }]);
    }
    for (const action of [...plugin.menus ?? [], ...plugin.keys ?? [], ...plugin.actions ?? []]) {
      if ((!!action.command === !!action.job) || (action.command && !editor.registry.command(action.command)) || (action.job && !editor.registry.job(action.job))) throw new Error(`Invalid surface action ${plugin.id}:${action.id}`);
    }
    menus.push(...plugin.menus ?? []);
    for (const binding of plugin.keys ?? []) keys.set(binding.key, [...keys.get(binding.key) ?? [], binding]);
    for (const action of plugin.actions ?? []) {
      if (legacyIds.has(action.id) || definitions.some(a => a.id === action.id)) throw new Error(`Duplicate action ID ${action.id}`);
      definitions.push(action);
      if (action.placements?.includes("slash")) menus.push(action);
      for (const key of action.keys ?? []) keys.set(key, [...keys.get(key) ?? [], { ...action, key }]);
    }
  }
  if (new Set(menus.map(m => m.id)).size !== menus.length) throw new Error("Duplicate menu action ID");
  for (const [slot, owner] of Object.entries(options.resolve ?? {})) if (!slot.startsWith("view:") || !providers.get(slot.slice(5))?.some(v => v.plugin === owner)) throw new Error(`Invalid view resolution ${slot} -> ${owner}`);
  for (const [type, entries] of providers) {
    const owner = options.resolve?.[`view:${type}`];
    if (entries.length > 1 && !owner) throw new Error(`Conflicting view:${type}`);
    views.set(type, owner ? entries.find(e => e.plugin === owner)! : entries[0]!);
  }
  for (const [key, entries] of keys) {
    if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error(`Duplicate key binding ID for ${key}`);
    const order = options.keyOrder?.[key];
    if (entries.length > 1 && !order) throw new Error(`Key ${key} requires an explicit keyOrder`);
    if (order) {
      if (new Set(order).size !== entries.length || order.length !== entries.length || order.some(id => !entries.some(e => e.id === id))) throw new Error(`Invalid keyOrder for ${key}`);
      keys.set(key, order.map(id => entries.find(e => e.id === id)!));
    }
  }
  for (const key of Object.keys(options.keyOrder ?? {})) if (!keys.has(key)) throw new Error(`Unknown keyOrder ${key}`);

  const root = document.createElement("div"), status = document.createElement("div"), body = document.createElement("div"), history = document.createElement("div");
  const surfaceAbort = new AbortController();
  root.className = "nq-editor"; root.append(status, body, history);
  const rows = new Map<string, Row>();
  let destroyed = false, scheduled = false, rendering = false, menu: HTMLElement | undefined, pendingSelection: SelectionRequest | undefined;
  let menuBlock: string | undefined;
  const actionRefreshers = new Set<() => void>();
  let renderState: DocState | undefined;
  let snapshotCache: { revision: number; value: Immutable<DocState> } | undefined;
  const fail = (plugin: string | undefined, cause: unknown) => editor.reportError({ plugin, phase: "view", cause });
  const snapshot = () => {
    // renderState is a fresh throwaway per render (EB-6): freeze in place —
    // the clone cost ~1.4ms per keystroke in the render microtask.
    if (snapshotCache?.revision !== editor.revision) snapshotCache = { revision: editor.revision, value: freezeInPlace(renderState ?? editor.view) };
    return snapshotCache.value;
  };
  const selection = (id: string): SelectionRequest => {
    return { block: id, ...rows.get(id)?.bindings[0]?.selection() ?? { anchor: 0, head: 0 } };
  };
  const actionContext = (id: string): SurfaceActionContext => Object.freeze({ block: id, snapshot: snapshot(), selection: Object.freeze(selection(id)) });
  const actions = createActions(editor, definitions, { context: actionContext,
    blocked: dispatch => destroyed ? "This surface is disposed." : dispatch && rendering ? "Views cannot dispatch while rendering." : undefined,
    report: cause => fail(undefined, cause),
  });
  let actionsScheduled = false;
  const refreshActions = () => {
    if (actionsScheduled || destroyed) return;
    actionsScheduled = true;
    queueMicrotask(() => {
      actionsScheduled = false; if (destroyed) return;
      for (const refresh of actionRefreshers) refresh();
    });
  };
  for (const type of ["select", "focusin", "keyup", "mouseup"]) root.addEventListener(type, refreshActions, { signal: surfaceAbort.signal });
  root.ownerDocument.addEventListener("selectionchange", () => {
    if (root.contains(root.ownerDocument.activeElement)) refreshActions();
  }, { signal: surfaceAbort.signal });
  const invoke = actions.invoke;
  const closeMenu = () => { menu?.remove(); menu = undefined; menuBlock = undefined; };
  const openMenu = (id: string) => {
    const focused = !!menu?.contains(document.activeElement);
    const active = menu?.querySelector('[aria-selected="true"]')?.getAttribute("data-nq-action");
    closeMenu(); if (!menus.length) return;
    const states = new Map(actions.list(id, "slash").map(state => [state.id, state.availability]));
    const items = menus.filter(m => states.get(m.id)?.status !== "hidden").map(m => {
      const state = states.get(m.id);
      return { label: m.label, type: m.id, glyph: m.glyph ?? "+", hint: m.hint ?? "", ai: !!m.job,
        disabled: state?.status === "disabled", reason: state?.status === "disabled" ? state.reason : undefined };
    });
    if (!items.length) return;
    menuBlock = id;
    menu = slashMenu({ items, active: Math.max(0, items.findIndex(item => item.type === active)),
      onSelect: item => { closeMenu(); invoke(menus.find(m => m.id === item.type)!, id); }, onClose: closeMenu,
    }); root.append(menu);
    if (focused) menu.querySelector<HTMLElement>('[role="listbox"]')?.focus();
  };

  function sendText(id: string, row: Row, changes: TextChange[]): boolean {
    if (destroyed || row.abort.signal.aborted) return false;
    if (rendering) { fail(undefined, new Error("Views cannot edit text while rendering")); return false; }
    if (!liveTree(editor.view).alive.has(id)) return false;
    try {
      if (editor.registry.command("nooq.text.edit")) {
        const result = editor.commands.run("nooq.text.edit", { block: id, changes });
        if (result.status === "failed") throw result.error;
        if (result.status === "denied") throw new Error(result.reason);
        return result.status === "applied";
      }
      editor.applyTextChanges(id, changes); return true;
    } catch (cause) { fail(undefined, cause); return false; }
  }
  function keyDown(id: string, event: KeyboardEvent): boolean {
    if (typeof process !== "undefined" && process.env.NQ_DEBUG_KEYS) console.log("[keyDown]", id, event.key, "actions:", (keys.get([event.ctrlKey ? "Ctrl" : "", event.metaKey ? "Meta" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.key].filter(Boolean).join("+")) ?? []).map((a) => a.id).join(","));
    if (event.key === "Escape") { closeMenu(); return true; }
    const key = [event.ctrlKey ? "Ctrl" : "", event.metaKey ? "Meta" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.key].filter(Boolean).join("+");
    for (const action of keys.get(key) ?? []) try {
      const outcome = invoke(action, id);
      if (typeof process !== "undefined" && process.env.NQ_DEBUG_KEYS) console.log("[invoke]", action.id, "->", outcome.status, JSON.stringify(outcome).slice(0, 200));
      if (outcome.status !== "not-applicable" && outcome.status !== "unavailable") return true;
    } catch (cause) { fail(undefined, cause); return true; }
    return false;
  }
  function mountRichText(id: string, row: Row, options?: RichTextOptions, input?: { keyDown(event: KeyboardEvent): boolean; beforeInput(event: InputEvent): boolean }) {
    if (row.bindings.length) throw new Error(`View ${id} mounted more than one text controller`);
    const rich = createRichText({ read: () => editor.view.blocks[id]?.text ?? { s: "", marks: [] },
      commit: changes => sendText(id, row, changes), keyDown: event => input ? input.keyDown(event) : keyDown(id, event),
      beforeInput: event => input?.beforeInput(event) ?? false,
      input: text => { if (text === "/") openMenu(id); else closeMenu(); },
    }, options);
    row.bindings.push({ ...rich, marks: options?.marks ?? ["strong", "em", "code"], update: block => rich.update(block.text ?? { s: "", marks: [] }) });
    return rich;
  }
  function mountText(id: string, row: Row, label = "Text block", input?: { keyDown(event: KeyboardEvent): boolean; beforeInput(event: InputEvent): boolean }): Binding & TextBinding {
    if (row.bindings.length) throw new Error(`View ${id} mounted more than one text controller`);
    const area = document.createElement("textarea"); area.className = "nq-input"; area.setAttribute("aria-label", label);
    let value = (renderState ?? editor.view).blocks[id]?.text?.s ?? "", compositionBase = value;
    area.value = value;
    const controller = new AbortController();
    const send = (changes: TextChange[]) => {
      if (!changes.length) return;
      const accepted = sendText(id, row, changes);
      value = editor.view.blocks[id]?.text?.s ?? "";
      if (!accepted) area.value = value;
    };
    const binding: Binding & TextBinding & { composing: boolean } = { element: area, composing: false,
      selection: () => ({ anchor: area.selectionDirection === "backward" ? area.selectionEnd : area.selectionStart, head: area.selectionDirection === "backward" ? area.selectionStart : area.selectionEnd }),
      focus(selection) { if (controller.signal.aborted) return; area.focus({ preventScroll: true }); if (selection) area.setSelectionRange(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head), selection.anchor > selection.head ? "backward" : "forward"); },
      insertText(text) {
        if (controller.signal.aborted || binding.composing) return false;
        const from = area.selectionStart, to = area.selectionEnd, direction = area.selectionDirection, before = area.value;
        const accepted = sendText(id, row, [{ retain: from }, { delete: to - from }, { insert: text }]);
        area.value = value = editor.view.blocks[id]?.text?.s ?? "";
        if (accepted) area.setSelectionRange(from + text.length, from + text.length);
        else {
          const remote = replaceChanges(before, value);
          area.setSelectionRange(caretAfterChanges(remote, from), caretAfterChanges(remote, to), direction);
        }
        return accepted;
      },
      update(block) {
        const next = block.text?.s ?? "";
        if (binding.composing) { value = next; return; }
        if (area.value !== next) {
          const delta = replaceChanges(value, next), start = caretAfterChanges(delta, area.selectionStart ?? 0), end = caretAfterChanges(delta, area.selectionEnd ?? 0), direction = area.selectionDirection;
          area.value = next; if (document.activeElement === area) area.setSelectionRange(start, end, direction);
        } value = next;
      }, destroy() { controller.abort(); },
    };
    const on = <K extends keyof HTMLElementEventMap>(type: K, callback: (event: HTMLElementEventMap[K]) => void) => area.addEventListener(type, callback, { signal: controller.signal });
    on("compositionstart", () => { binding.composing = true; compositionBase = area.value; });
    on("compositionend", () => {
      if (!binding.composing) return;
      binding.composing = false;
      const local = replaceChanges(compositionBase, area.value), remote = replaceChanges(compositionBase, editor.view.blocks[id]?.text?.s ?? "");
      let offset = 0, removed = 0, inserted = "", editing = false;
      for (const step of local) {
        if ("retain" in step && !editing) offset += step.retain;
        if ("delete" in step) { editing = true; removed += step.delete; }
        if ("insert" in step) { editing = true; inserted += step.insert; }
      }
      const from = caretAfterChanges(remote, offset), to = caretAfterChanges(remote, offset + removed);
      send([{ retain: from }, { delete: Math.max(0, to - from) }, { insert: inserted }]);
      area.value = value; area.setSelectionRange(from + inserted.length, from + inserted.length);
    });
    on("input", () => {
      if (binding.composing) return;
      send(replaceChanges(editor.view.blocks[id]?.text?.s ?? "", area.value));
      if (area.value === "/") openMenu(id); else closeMenu();
    });
    on("keydown", event => {
      if (binding.composing || event.isComposing) return;
      if (input ? input.keyDown(event) : keyDown(id, event)) event.preventDefault();
    });
    on("beforeinput", event => {
      const before = event as InputEvent;
      if (!binding.composing && !before.isComposing && before.cancelable && input?.beforeInput(before)) before.preventDefault();
    });
    row.bindings.push(binding); return binding;
  }

  function mountTextEditor(id: string, row: Row, label?: string, policy = defaultTextPolicy): TextEditorBinding {
    const mode = textMode ?? policy.defaultMode ?? "plain";
    let binding: Pick<Binding, "insertText"> & TextEditorBinding;
    const enter = (lineBreak: boolean) => {
      if (destroyed || row.abort.signal.aborted || rendering || !liveTree(editor.view).alive.has(id)) return;
      // Admission may precede the queued render. Map the native range to the
      // current text before sending a selection to a structural command.
      row.bindings[0]?.update(editor.view.blocks[id]!);
      if (lineBreak || !policy.enter || policy.enter === "newline") { binding.insertText("\n"); return; }
      const current = selection(id);
      const result = editor.commands.run(policy.enter.command, current, { selection: current });
      if (result.status === "failed") fail(undefined, result.error);
      else if (result.status === "denied") fail(undefined, new Error(result.reason));
      // A declined/denied split is consumed. Falling back to a newline would be a different edit.
    };
    const input = {
      keyDown(event: KeyboardEvent) {
        if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) { enter(event.shiftKey); return true; }
        return keyDown(id, event);
      },
      beforeInput(event: InputEvent) {
        if (event.inputType !== "insertParagraph" && event.inputType !== "insertLineBreak") return false;
        enter(event.inputType === "insertLineBreak"); return true;
      },
    };
    binding = mode === "rich" ? { ...mountRichText(id, row, { label, marks: policy.marks }, input), mode }
      : { ...mountText(id, row, label, input), mode, toggleMark: () => false };
    return binding;
  }

  function fallback(id: string, row: Row): BlockView {
    const element = document.createElement("section"), label = document.createElement("strong"), fields = document.createElement("pre");
    const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "Stored fields"; details.append(summary, fields);
    element.className = "nq-block nq-fallback"; element.append(label);
    const block = (renderState ?? editor.view).blocks[id]!;
    if (block.text || editor.registry.block(block.type)?.definition.text === "inline") element.append(mountTextEditor(id, row).element);
    element.append(details, row.children);
    return { element, update(block) { label.textContent = block.type; fields.textContent = JSON.stringify(block.fields, null, 2); } };
  }
  function cleanup(row: Row) {
    row.abort.abort();
    for (const binding of row.bindings.splice(0)) binding.destroy();
    for (const dispose of row.cleanups.splice(0).reverse()) try { dispose(); } catch (cause) { fail(undefined, cause); }
    try { row.view?.destroy?.(); } catch (cause) { fail(undefined, cause); }
  }
  function makeRow(id: string, block: Block): Row {
    const shell = document.createElement("div"), children = document.createElement("div"), presence = document.createElement("div");
    shell.dataset.nqBlock = id; children.className = "nq-children";
    const row: Row = { id, shell, children, presence, view: undefined!, abort: new AbortController(), bindings: [], cleanups: [], signature: "", type: block.type };
    const provider = views.get(block.type);
    const signal = row.abort.signal;
    const canAct = () => { if (signal.aborted || destroyed) throw new Error("View is disposed"); if (rendering) throw new Error("Views cannot dispatch while rendering"); };
    const context: BlockViewContext = {
      block: id, signal, children: { element: children }, mountText: options => { if (signal.aborted) throw new Error("View is disposed"); return mountText(id, row, options?.label); },
      mountRichText: options => { if (signal.aborted) throw new Error("View is disposed"); return mountRichText(id, row, options); },
      mountTextEditor: options => { if (signal.aborted) throw new Error("View is disposed"); return mountTextEditor(id, row, options?.label, provider?.textPolicy); },
      actions: {
        list: placement => signal.aborted ? [] : actions.list(id, placement),
        run: action => signal.aborted ? { status: "unavailable", reason: "View is disposed." } : actions.run(action, id),
      },
      mountActionToolbar: options => {
        if (signal.aborted) throw new Error("View is disposed");
        const toolbar = mountActionToolbar({ list: placement => actions.list(id, placement),
          run: action => signal.aborted ? { status: "unavailable", reason: "View is disposed." } : actions.run(action, id),
          subscribe: refresh => { actionRefreshers.add(refresh); return () => { actionRefreshers.delete(refresh); }; },
        }, options?.label);
        row.cleanups.push(() => toolbar.destroy()); return toolbar;
      },
      run: (command, args) => { try { canAct(); return editor.commands.run(command, args, { selection: selection(id) }); } catch (error) { return { status: "failed", error }; } }, selection: () => selection(id), snapshot, authors: () => editor.authorsOf(id),
      onChange: listener => { if (signal.aborted) return () => {}; const off = editor.onChange(() => { if (!signal.aborted) try { listener(); } catch (cause) { fail(provider?.plugin, cause); } }); row.cleanups.push(off); return off; },
      review: () => editor.reviewSuggestion(id), accept: async options => { canAct(); await editor.accept(id, { ...options, signal }); }, reject: () => { canAct(); editor.reject(id); }, report: cause => fail(provider?.plugin, cause),
    };
    try {
      row.view = provider ? provider.mount(context) : fallback(id, row);
      row.view.update(freezeSnapshot(block));
      if (!row.view.element.contains(children)) throw new Error(`View ${provider?.plugin} must retain its children container`);
    } catch (cause) {
      fail(provider?.plugin, cause); cleanup(row); row.abort = new AbortController(); row.view = fallback(id, row); row.view.update(freezeSnapshot(block));
    }
    row.signature = JSON.stringify(block);
    shell.append(presence, row.view.element); return row;
  }
  function schedule() { if (!scheduled && !destroyed) { scheduled = true; queueMicrotask(render); } }
  let mountedFocused = false;
  /** Lab/test observability: remote renders seen, pins applied (EB-7). */
  const stats = { remoteRenders: 0, pins: 0, lastAnchor: null as string | null, lastDrift: 0, lastAnchorRect: null as { top: number; bottom: number } | null, lastViewportTop: 0, renderCounts: { targeted: 0, full: 0, presence: 0 } };

  /** The anchor row keeping the viewport still across remote renders (EB-7):
   *  the FIRST row overlapping the viewport top — the same block the lab's
   *  checker holds still (bottom > top edge), not the first fully-visible
   *  row, which is a different block whenever one straddles the edge. */
  function pickAnchor(): { row: HTMLElement; top: number } | null {
    const scroller = document.scrollingElement;
    if (!scroller) return null;
    // Rects are viewport-relative: the visible top is 0. (The scroller's own
    // rect top is NOT a proxy — a scrolling <html> reports -scrollY, which
    // once admitted rows 800px above the viewport; measured, not assumed.)
    // EXACTLY the checker's definition, in its iteration order: the first
    // block row in DOM order whose bottom crosses the visible top.
    for (const shell of Array.from(root.querySelectorAll<HTMLElement>("[data-nq-block]"))) {
      const rect = shell.getBoundingClientRect();
      if (rect.bottom > 0) return { row: shell, top: rect.top };
    }
    return null;
  }
  function pinViewport(anchor: { row: HTMLElement; top: number } | null): void {
    if (!anchor || !anchor.row.isConnected) return;
    const scroller = document.scrollingElement;
    if (!scroller) return;
    const drift = anchor.row.getBoundingClientRect().top - anchor.top;
    stats.lastDrift = drift;
    if (drift !== 0) { scroller.scrollTop += drift; stats.pins++; }
  }

  function render() {
    documentSelection?.beforeRender();
    scheduled = false; if (destroyed) return;
    rendering = true;
    const batch = pendingBatch; const remote = batchIsRemote;
    pendingBatch = null; batchIsRemote = false;
    // Which blocks earn expensive work? null = everything (initial/access/awareness-only).
    let changedIds: Set<string> | null = null;
    let structural = false;
    if (batch !== null && batch.length > 0) {
      changedIds = new Set<string>();
      for (const event of batch) {
        for (const id of event.blocks) changedIds.add(id);
        if (event.roots || event.access) { changedIds = null; break; }
        for (const info of Object.values(event.changes ?? {})) if (info.structure) structural = true;
      }
    }
    if (batch === null) stats.renderCounts.presence++; else if (changedIds === null) stats.renderCounts.full++; else stats.renderCounts.targeted++;
    if (remote) stats.remoteRenders++;
    const anchor = remote ? pickAnchor() : null;
    stats.lastAnchor = anchor?.row.getAttribute("data-nq-block") ?? null;
    if (anchor) {
      stats.lastAnchorRect = { top: Math.round(anchor.row.getBoundingClientRect().top), bottom: Math.round(anchor.row.getBoundingClientRect().bottom) };
      stats.lastViewportTop = Math.round((document.scrollingElement as HTMLElement | null)?.getBoundingClientRect().top ?? 0);
    }
    try {
    const state = editor.view, alive = liveTree(state).alive, wanted = new Set<string>();
    renderState = state;
    const active = [...rows.values()].flatMap(row => row.bindings).find(binding => binding.element.contains(document.activeElement));
    const activeSelection = active?.selection();
    status.replaceChildren(syncStatus({ state: editor.hasTransport ? editor.synced ? "synced" : "syncing" : "local", count: editor.awareness.size }));
    const walk = (ids: readonly string[], parent: HTMLElement) => {
      let at = 0;
      for (const id of ids) {
        const block = state.blocks[id]; if (!block || wanted.has(id)) continue;
        wanted.add(id);
        let row = rows.get(id);
        if (row && row.type !== block.type) { cleanup(row); row.shell.remove(); rows.delete(id); row = undefined; }
        if (!row) { row = makeRow(id, block); rows.set(id, row); }
        for (const binding of row.bindings) binding.update(block);
        const signature = JSON.stringify(block);
        if (signature !== row.signature) {
          try { row.view.update(freezeSnapshot(block)); if (!row.view.element.contains(row.children)) throw new Error("View removed its children container"); }
          catch (cause) { fail(views.get(block.type)?.plugin, cause); cleanup(row); row.abort = new AbortController(); row.view.element.remove(); row.view = fallback(id, row); row.view.update(freezeSnapshot(block)); row.shell.append(row.view.element); }
          row.signature = signature;
        }
        const peers = [...editor.awareness.values()].filter(p => p.cursor?.block === id);
        row.presence.replaceChildren(...peers.map(p => presenceCaret({ name: p.name ?? p.actor, ink: "slate" })));
        if (parent.children[at] !== row.shell) parent.insertBefore(row.shell, parent.children[at] ?? null);
        at++; walk(block.children, row.children);
      }
    };
    walk(state.roots, body);
    if (structural || changedIds === null) {
      const historic: string[] = [];
      for (const plugin of plugins) try { historic.push(...plugin.history?.(snapshot()) ?? []); } catch (cause) { fail(plugin.id, cause); }
      walk(historic.filter(id => !alive.has(id)), history);
    }
    for (const [id, row] of rows) if (!wanted.has(id)) { cleanup(row); row.shell.remove(); rows.delete(id); }
    // EB-5: editable in the frame the surface becomes visible — no clicking.
    if (!mountedFocused && root.isConnected) {
      mountedFocused = true;
      if (!root.contains(document.activeElement)) {
        const first = [...rows.values()].find((row) => alive.has(row.id) && row.bindings[0]);
        const caret = state.blocks[first?.id ?? ""]?.text?.s.length ?? 0;
        first?.bindings[0]?.focus({ anchor: caret, head: caret });
      }
    }
    if (anchor) pinViewport(anchor);
    if (active && root.contains(active.element) && !active.element.contains(document.activeElement)) active.focus(activeSelection);
    if (pendingSelection) {
      const request = pendingSelection; pendingSelection = undefined;
      const binding = rows.get(request.block)?.bindings[0];
      if (binding && alive.has(request.block)) binding.focus(request);
    }
    for (const refresh of actionRefreshers) refresh();
    if (menuBlock) {
      if (alive.has(menuBlock) && state.blocks[menuBlock]?.text?.s === "/") openMenu(menuBlock);
      else closeMenu();
    }
    } finally { rendering = false; renderState = undefined; documentSelection?.afterRender(); }
  }
  // EB-6: render only what the transactions touched; a null set means all.
  let pendingBatch: import("@nooq/plugins").ChangeEvent[] | null = null;
  let batchIsRemote = false;
  const offEvents = editor.onEvents((events) => {
    pendingBatch = pendingBatch === null ? [...events] : [...pendingBatch, ...events];
    if (events.some((event) => event.origin === "remote")) batchIsRemote = true;
  });
  const documentSelection = options.selectionMode === "document" ? createDocumentSelection(editor, root, () => new Map(
    [...rows].flatMap(([id, row]) => row.bindings[0] ? [[id, { ...row.bindings[0], marks: row.bindings[0].marks ?? null }] as const] : []),
  ), () => destroyed || rendering) : undefined;
  if (documentSelection) { root.classList.add("nq-document-selection"); root.tabIndex = -1; root.dataset.nqDocumentSelection = "true"; }
  const offChange = editor.onChange(schedule), offSelection = editor.onSelection(request => { pendingSelection = request; schedule(); });
  let offClose = () => {};
  const destroy = () => { if (destroyed) return; destroyed = true; documentSelection?.destroy(); surfaceAbort.abort(); offEvents(); offChange(); offSelection(); offClose(); closeMenu(); for (const row of rows.values()) cleanup(row); rows.clear(); root.remove(); };
  offClose = editor.onClose(destroy); schedule();
  return { element: root, actions, ...(documentSelection ? { selection: documentSelection.service } : {}), destroy, get remoteRenders() { return stats.remoteRenders; }, get pins() { return stats.pins; }, get lastAnchor() { return stats.lastAnchor; }, get lastDrift() { return stats.lastDrift; }, get lastAnchorRect() { return stats.lastAnchorRect; }, get lastViewportTop() { return stats.lastViewportTop; }, get renderCounts() { return stats.renderCounts; } };
}
