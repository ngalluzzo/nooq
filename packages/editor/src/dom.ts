/** Plugin-driven surface: views own their content; the host owns text and children. */
import { caretAfterChanges, liveTree, replaceChanges, type Block, type DocState, type TextChange } from "@nooq/core";
import { freezeSnapshot, type Immutable, type SelectionRequest } from "@nooq/plugins";
import type { BlockView, BlockViewContext, DOMPlugin, RichTextOptions, SurfaceAction, SurfaceActionContext, TextBinding, TextSelection } from "@nooq/plugins/dom";
import { presenceCaret, slashMenu, syncStatus } from "@nooq/design";
import type { Editor } from "./controller.ts";
import { mountRichText as createRichText } from "./rich-text.ts";

export interface EditorSurface { element: HTMLElement; destroy(): void }
export interface SurfaceOptions {
  plugins?: readonly DOMPlugin[];
  resolve?: Readonly<Record<string, string>>;
  keyOrder?: Readonly<Record<string, readonly string[]>>;
}
interface Binding { element: HTMLElement; update(block: Block): void; selection(): TextSelection; focus(selection?: TextSelection): void; destroy(): void }
interface Row {
  shell: HTMLElement; children: HTMLElement; presence: HTMLElement; view: BlockView;
  abort: AbortController; bindings: Binding[]; cleanups: (() => void)[]; signature: string; type: string;
}

export function createSurface(editor: Editor, options: SurfaceOptions = {}): EditorSurface {
  const plugins = options.plugins ?? [], views = new Map<string, { plugin: string; mount: DOMPlugin["views"][number]["mount"] }>();
  const providers = new Map<string, { plugin: string; mount: DOMPlugin["views"][number]["mount"] }[]>();
  const seen = new Set<string>(), menus: SurfaceAction[] = [];
  const keys = new Map<string, NonNullable<DOMPlugin["keys"]>[number][]>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) throw new Error(`Duplicate DOM plugin ${plugin.id}`);
    seen.add(plugin.id);
    if (!editor.registry.plugins.some(p => p.id === plugin.forPlugin.id && p.version === plugin.forPlugin.version)) throw new Error(`DOM plugin ${plugin.id} requires ${plugin.forPlugin.id}@${plugin.forPlugin.version}`);
    for (const view of plugin.views) {
      if (!editor.registry.block(view.type)) throw new Error(`View ${plugin.id} references unknown block ${view.type}`);
      providers.set(view.type, [...providers.get(view.type) ?? [], { plugin: plugin.id, mount: view.mount }]);
    }
    for (const action of [...plugin.menus ?? [], ...plugin.keys ?? []]) {
      if ((!!action.command === !!action.job) || (action.command && !editor.registry.command(action.command)) || (action.job && !editor.registry.job(action.job))) throw new Error(`Invalid surface action ${plugin.id}:${action.id}`);
    }
    menus.push(...plugin.menus ?? []);
    for (const binding of plugin.keys ?? []) keys.set(binding.key, [...keys.get(binding.key) ?? [], binding]);
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
  root.className = "nq-editor"; root.append(status, body, history);
  const rows = new Map<string, Row>();
  let destroyed = false, scheduled = false, rendering = false, menu: HTMLElement | undefined, pendingSelection: SelectionRequest | undefined;
  let renderState: DocState | undefined;
  let snapshotCache: { revision: number; value: Immutable<DocState> } | undefined;
  const fail = (plugin: string | undefined, cause: unknown) => editor.reportError({ plugin, phase: "view", cause });
  const snapshot = () => {
    if (snapshotCache?.revision !== editor.revision) snapshotCache = { revision: editor.revision, value: freezeSnapshot(renderState ?? editor.view) };
    return snapshotCache.value;
  };
  const selection = (id: string): SelectionRequest => {
    return { block: id, ...rows.get(id)?.bindings[0]?.selection() ?? { anchor: 0, head: 0 } };
  };
  const actionContext = (id: string): SurfaceActionContext => ({ block: id, snapshot: snapshot(), selection: selection(id) });
  const invoke = (action: SurfaceAction, id: string) => {
    try {
      const ctx = actionContext(id), args = action.args(ctx);
      if (action.command) return editor.commands.run(action.command, args, { selection: ctx.selection });
      const job = editor.jobs.start(action.job!, args);
      void job.result.catch(cause => { if (!job.signal.aborted) fail(undefined, cause); });
      return { status: "started" };
    } catch (error) { fail(undefined, error); return { status: "failed" }; }
  };
  const closeMenu = () => { menu?.remove(); menu = undefined; };
  const openMenu = (id: string) => {
    closeMenu(); if (!menus.length) return;
    menu = slashMenu({ items: menus.map(m => ({ label: m.label, type: m.id, glyph: m.glyph ?? "+", hint: m.hint ?? "", ai: !!m.job })),
      onSelect: item => { closeMenu(); invoke(menus.find(m => m.id === item.type)!, id); }, onClose: closeMenu,
    }); root.append(menu);
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
    if (event.key === "Escape") { closeMenu(); return true; }
    const key = [event.ctrlKey ? "Ctrl" : "", event.metaKey ? "Meta" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.key].filter(Boolean).join("+");
    for (const action of keys.get(key) ?? []) try {
      if (action.when && !action.when(actionContext(id))) continue;
      const outcome = invoke(action, id);
      if (outcome.status !== "not-applicable") return true;
    } catch (cause) { fail(undefined, cause); return true; }
    return false;
  }
  function mountRichText(id: string, row: Row, options?: RichTextOptions) {
    if (row.bindings.length) throw new Error(`View ${id} mounted more than one text controller`);
    const rich = createRichText({ read: () => editor.view.blocks[id]?.text ?? { s: "", marks: [] },
      commit: changes => sendText(id, row, changes), keyDown: event => keyDown(id, event),
      input: text => { if (text === "/") openMenu(id); else closeMenu(); },
    }, options);
    row.bindings.push({ ...rich, update: block => rich.update(block.text ?? { s: "", marks: [] }) });
    return rich;
  }
  function mountText(id: string, row: Row, label = "Text block"): Binding & TextBinding {
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
      focus(selection) { if (controller.signal.aborted) return; area.focus(); if (selection) area.setSelectionRange(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head), selection.anchor > selection.head ? "backward" : "forward"); },
      update(block) {
        const next = block.text?.s ?? "";
        if (binding.composing) { value = next; return; }
        if (area.value !== next) {
          const delta = replaceChanges(value, next), start = caretAfterChanges(delta, area.selectionStart ?? 0), end = caretAfterChanges(delta, area.selectionEnd ?? 0);
          area.value = next; if (document.activeElement === area) area.setSelectionRange(start, end);
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
      if (keyDown(id, event)) event.preventDefault();
    });
    row.bindings.push(binding); return binding;
  }

  function fallback(id: string, row: Row): BlockView {
    const element = document.createElement("section"), label = document.createElement("strong"), fields = document.createElement("pre");
    const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "Stored fields"; details.append(summary, fields);
    element.className = "nq-block nq-fallback"; element.append(label);
    const block = (renderState ?? editor.view).blocks[id]!;
    if (block.text || editor.registry.block(block.type)?.definition.text === "inline") element.append(mountText(id, row).element);
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
    const row: Row = { shell, children, presence, view: undefined!, abort: new AbortController(), bindings: [], cleanups: [], signature: "", type: block.type };
    const provider = views.get(block.type);
    const signal = row.abort.signal;
    const canAct = () => { if (signal.aborted || destroyed) throw new Error("View is disposed"); if (rendering) throw new Error("Views cannot dispatch while rendering"); };
    const context: BlockViewContext = {
      block: id, signal, children: { element: children }, mountText: options => { if (signal.aborted) throw new Error("View is disposed"); return mountText(id, row, options?.label); },
      mountRichText: options => { if (signal.aborted) throw new Error("View is disposed"); return mountRichText(id, row, options); },
      run: (command, args) => { try { canAct(); return editor.commands.run(command, args, { selection: selection(id) }); } catch (error) { return { status: "failed", error }; } }, selection: () => selection(id), snapshot,
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
  function render() {
    scheduled = false; if (destroyed) return;
    rendering = true;
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
    const historic: string[] = [];
    for (const plugin of plugins) try { historic.push(...plugin.history?.(snapshot()) ?? []); } catch (cause) { fail(plugin.id, cause); }
    walk(historic.filter(id => !alive.has(id)), history);
    for (const [id, row] of rows) if (!wanted.has(id)) { cleanup(row); row.shell.remove(); rows.delete(id); }
    if (active && root.contains(active.element) && !active.element.contains(document.activeElement)) active.focus(activeSelection);
    if (pendingSelection) {
      const request = pendingSelection; pendingSelection = undefined;
      const binding = rows.get(request.block)?.bindings[0];
      if (binding && alive.has(request.block)) binding.focus(request);
    }
    } finally { rendering = false; renderState = undefined; }
  }
  const offChange = editor.onChange(schedule), offSelection = editor.onSelection(request => { pendingSelection = request; schedule(); });
  let offClose = () => {};
  const destroy = () => { if (destroyed) return; destroyed = true; offChange(); offSelection(); offClose(); closeMenu(); for (const row of rows.values()) cleanup(row); rows.clear(); root.remove(); };
  offClose = editor.onClose(destroy); schedule();
  return { element: root, destroy };
}
