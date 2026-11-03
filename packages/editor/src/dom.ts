/** Plugin-driven surface: views own their content; the host owns text and children. */
import { caretAfterChanges, liveTree, replaceChanges, type Block, type DocState, type Op, type TextChange } from "@nooq/core";
import * as Y from "yjs";
import { layout } from "@nooq/yjs";
import { freezeInPlace, freezeSnapshot, textBlockOrder, type Immutable, type PluginError, type SelectionRequest } from "@nooq/plugins";
import { defineTextPolicy, type Action, type DocumentSelectionService, type TextMark, type BlockView, type BlockViewContext, type DOMPlugin, type RichTextOptions, type SurfaceAction, type SurfaceActionContext, type SurfaceActions, type TextBinding, type TextEditorBinding, type TextMode, type TextPolicy, type TextSelection } from "@nooq/plugins/dom";
import { loading, notice, presenceCaret, slashMenu, syncStatus, type NoticeAction } from "@nooq/design";
import { AuthorizationError, SessionError, type Editor } from "./controller.ts";
import { mountRichText as createRichText, type RichTextSurfaceOptions } from "./rich-text.ts";
import { createActions, mountActionToolbar } from "./actions.ts";
import { importMarkdown as pluginsImportMarkdown } from "@nooq/plugins";
import { createJobsUI } from "./jobs-ui.ts";
import { createHistoryLayer, openBlockHistory, viewKeepsHistory } from "./history-ui.ts";
import { createAwayTracker, type AwayTracker } from "./away.ts";
import { createSupersededDetector, type SupersededDetector, type SupersededEvent } from "./superseded.ts";
import { createLinkUI } from "./link-ui.ts";
import { createFormatToolbar } from "./format-toolbar.ts";
import { mountShortcutSheet } from "./shortcuts.ts";
import { createDocumentSelection } from "./document-selection.ts";
import { createPresence } from "./presence.ts";
import { createSurfaceStatus } from "./status.ts";
import type { CursorAnchor } from "@nooq/sync";

/** One entry of the surface's resolved keymap: the registered action a key string dispatches to (task-16). */
export type KeyBinding = NonNullable<DOMPlugin["keys"]>[number];
export interface EditorSurface {
  element: HTMLElement;
  actions: SurfaceActions;
  /** The resolved key bindings (key string → keyOrder-ordered entries) that keyDown dispatches through; the shortcut sheet reads this live map so it cannot drift (task-16). */
  readonly keymap: ReadonlyMap<string, readonly KeyBinding[]>;
  /** The text presentation override this surface was created with (task-16). */
  readonly textMode: TextMode | undefined;
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
  readonly renderCounts: { targeted: number; full: number; presence: number; windowed: number };
  readonly mountedRows: number;
  /** Away-marker state (foundation P1): the surface wires detection and the three clears; `force` is the test/story seam for windowed-out truth. */
  readonly away: AwayTracker;
  /** DM-4.9 supersession state: the surface wires detection into the notice channel; `force` is the test/story seam for a race that cannot be timed in a harness. */
  readonly superseded: SupersededDetector;
  estimateTop(id: string): number;
}
export interface SurfaceOptions {
  plugins?: readonly DOMPlugin[];
  resolve?: Readonly<Record<string, string>>;
  keyOrder?: Readonly<Record<string, readonly string[]>>;
  /** Overrides presentation for mountTextEditor views; explicit legacy bindings stay explicit. */
  textMode?: TextMode;
  /** Opt in to cross-block rich-text selection; requires textMode: rich and nooq.text.edit. */
  selectionMode?: "block" | "document";
  /** The open state's quiet window before the loading wordmark shows, in ms. Default 300; tests pass 0 to observe it. */
  loadingDelay?: number;
}
/** Rich bindings carry the bases their policy admits for authoring (0009 §2); plain bindings carry none. */
interface Binding { marks?: readonly string[]; element: HTMLElement; update(block: Block): void; selection(): TextSelection; focus(selection?: TextSelection): void; insertText(text: string): boolean; /** The rich host's toggle path (Mod-b's), which the formatting toolbar reuses rather than inventing a second. */ toggleMark?(mark: TextMark): boolean; destroy(): void }
type ViewProvider = { plugin: string; mount: DOMPlugin["views"][number]["mount"]; textPolicy?: TextPolicy; /** View-level extra the raw definition carried (rendersHistory for tombstone-keeping views). */ rendersHistory?: boolean };
const defaultTextPolicy = defineTextPolicy();
interface Row {
  id: string;
  shell: HTMLElement; children: HTMLElement; presence: HTMLElement; view: BlockView;
  abort: AbortController; bindings: Binding[]; cleanups: (() => void)[]; signature: string; type: string;
  /** The sr word riding this row while it is marked away (§9); the tracker decides it, the surface owns it. */
  awayWord?: HTMLElement;
}

export function createSurface(editor: Editor, options: SurfaceOptions = {}): EditorSurface {
  if (options.textMode !== undefined && options.textMode !== "plain" && options.textMode !== "rich") throw new Error("Invalid surface text mode");
  if (options.selectionMode !== undefined && !["block", "document"].includes(options.selectionMode)) throw new Error("Invalid selection mode");
  if (options.selectionMode === "document" && (options.textMode !== "rich" || !editor.registry.command("nooq.text.edit"))) throw new Error("Document selection requires textMode: rich and a registered nooq.text.edit command");
  const textMode = options.textMode;
  const plugins = options.plugins ?? [], views = new Map<string, ViewProvider>();
  /** §7 surface hooks (the drag handle): collected at registration, invoked after the root exists, cleaned up on destroy. */
  const surfaceHooks: Array<{ plugin: string; hook: (context: import("@nooq/plugins/dom").SurfacePluginContext) => void | (() => void) }> = [];
  const surfaceCleanups: Array<() => void> = [];
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
      providers.set(view.type, [...providers.get(view.type) ?? [], { plugin: plugin.id, mount: view.mount, textPolicy: policy, rendersHistory: view.rendersHistory === true ? true : undefined }]);
    }
    for (const action of [...plugin.menus ?? [], ...plugin.keys ?? [], ...plugin.actions ?? []]) {
      if ((!!action.command === !!action.job) || (action.command && !editor.registry.command(action.command)) || (action.job && !editor.registry.job(action.job))) throw new Error(`Invalid surface action ${plugin.id}:${action.id}`);
    }
    menus.push(...plugin.menus ?? []);
    for (const binding of plugin.keys ?? []) keys.set(binding.key, [...keys.get(binding.key) ?? [], binding]);
    if (plugin.surface) surfaceHooks.push({ plugin: plugin.id, hook: plugin.surface }); // invoked once the root exists (below)
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

  const root = document.createElement("div"), status = document.createElement("div"), notices = document.createElement("div"), body = document.createElement("div"), history = document.createElement("div");
  const surfaceAbort = new AbortController();
  root.className = "nq-editor"; root.append(status, notices, body, history);
  // The open state (foundation P2, brand book Motion): a loading host above
  // the content at the overlay layer, pointer-transparent, shown only when the
  // load outlives the delay. It leaves when the FIRST render has run AND the
  // editor is ready — a local doc settles both inside one microtask and never
  // shows anything; a remote bootstrap keeps the wordmark until then. It
  // exists only until that point and never touches the input path (§3).
  const loadHost = loading(options.loadingDelay === undefined ? {} : { delay: options.loadingDelay });
  root.append(loadHost.element);
  let firstRenderDone = false, readyForContent = false, loadingSettled = false;
  const settleLoading = () => { if (!loadingSettled && firstRenderDone && readyForContent) { loadingSettled = true; loadHost.done(); } };
  const rows = new Map<string, Row>();
  // A freshly derived ink re-renders rows too: their chips wait for the ink
  // rather than show a peer in a borrowed color, same as the overlay.
  const presence = createPresence(root, () => new Map([...rows].flatMap(([id, row]) => row.bindings[0]?.marks !== undefined ? [[id, row.bindings[0].element] as const] : [])), schedule);
  // The status area's presence half (foundation P1): the roster beside the
  // sync line and the shared announcer for joins, leaves and stale transitions.
  const surfaceStatus = createSurfaceStatus(editor, presence);
  // The history layer (0005, DM-14.4): tombstoned blocks as deleted rows with Restore.
  const historyLayer = createHistoryLayer(editor, history, presence);
  // Away markers (foundation P1): a remote change to a block this writer
  // could not see — not in the rows map; windowed-out is truth — marks its
  // row. The tracker owns every mark/clear/drop decision; this surface owns
  // every DOM consequence: the data-nq-away attribute on its row shell (the
  // bar stays the view's own, notched by [data-nq-away] CSS in the theme)
  // and the .nq-sr word inside the shell (§9's word channel).
  const away = createAwayTracker({
    mountedIds: () => rows.keys(),
    onFlip: id => { const row = rows.get(id); if (row) applyAway(row); },
  });
  const AWAY_WORD = "Changed while you were away";
  /** Sync one row's shell with the tracker: the attribute drives the notched bar, the sr span says it in words. Idempotent — nothing happens per render while unchanged. */
  function applyAway(row: Row): void {
    if (away.isMarked(row.id)) {
      if (row.awayWord === undefined) {
        const word = document.createElement("span");
        word.className = "nq-sr";
        word.textContent = AWAY_WORD;
        row.presence.before(word); // first in the shell: the state reads before the content
        row.awayWord = word;
      }
      if (!("nqAway" in row.shell.dataset)) row.shell.dataset.nqAway = "true";
    } else {
      if (row.awayWord !== undefined) { row.awayWord.remove(); row.awayWord = undefined; }
      if ("nqAway" in row.shell.dataset) delete row.shell.dataset.nqAway;
    }
  }
  let destroyed = false, scheduled = false, rendering = false, menu: HTMLElement | undefined, pendingSelection: SelectionRequest | undefined;
  let menuBlock: string | undefined;
  const actionRefreshers = new Set<() => void>();
  // The working state (foundation P1): strips and draft previews for running
  // jobs, re-attached by the row walk below. Mounts nothing until a job starts.
  const jobs = createJobsUI(editor);
  // Link editing (0009 §5): Mod-k on a rich host's selection. Admission is the
  // selected view's policy; the chord lives off the input path (§3).
  const links = createLinkUI({ editor, report: cause => fail(undefined, cause), host: id => {
    const row = rows.get(id), binding = row?.bindings[0];
    if (!binding || binding.marks === undefined || !binding.element.isConnected) return undefined;
    return { anchor: binding.element, selection: binding.selection, focus: binding.focus, marks: views.get(row.type)?.textPolicy?.marks };
  } });
  // The formatting toolbar (foundation P1): the pointer-only selection strip.
  // Toggles ride the binding's own mark path (the one Mod-b flows through),
  // and Link opens the same flow Mod-k opens — one popover, one contract.
  /** The block whose rich host wholly holds a non-collapsed document selection (the strip's pointer policy). */
  const selectedRichBlock = (): string | undefined => {
    const selection = root.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
    for (const [id, row] of rows) {
      const binding = row.bindings[0];
      if (!binding || binding.marks === undefined || !binding.element.isConnected) continue;
      if (binding.element.contains(selection.anchorNode) && binding.element.contains(selection.focusNode)) return id;
    }
    return undefined;
  };
  const formatToolbar = createFormatToolbar(editor, {
    mount: root,
    report: cause => fail(undefined, cause),
    selectionBlock: selectedRichBlock,
    host: id => {
      const row = rows.get(id), binding = row?.bindings[0];
      if (!binding || binding.marks === undefined || !binding.element.isConnected) return undefined;
      return { anchor: binding.element, selection: binding.selection, toggleMark: mark => binding.toggleMark?.(mark) ?? false, marks: binding.marks };
    },
    policyBases: id => views.get(rows.get(id)?.type ?? "")?.textPolicy?.marks,
    openLink: id => links.open(id),
  });
  // The shortcut sheet (foundation P2): "?" opens the keyboard reference in a
  // popover anchored to the surface root; the collector reads the resolved
  // key map above at open time, so the sheet cannot drift from keyDown.
  const shortcuts = mountShortcutSheet({ element: root, keymap: keys, textMode, signal: surfaceAbort.signal });
  // Tier-2 paste (gap audit #5): markdown-shaped text becomes blocks — the
  // import is the export engine's inverse, and the round trip is pinned by
  // test. Plain single-line text falls through to the ordinary typing path;
  // unknown syntax degrades to paragraphs, never a failed paste.
  const MARKDOWN_LINE = /^\s*(#{1,6}\s|[-*]\s|\d+[.)]\s|[-*]\s\[ |x|X\]|>|---|===|\*\*\*)/;
  const looksMarkdown = (text: string): boolean => text.split(/\r?\n/).some(line => MARKDOWN_LINE.test(line));
  const onPaste = (event: ClipboardEvent): void => {
    if (destroyed || rendering || !event.clipboardData) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text || !looksMarkdown(text)) return; // ordinary text: the input path owns it
    const focused = document.activeElement instanceof Element ? document.activeElement.closest<HTMLElement>("[data-nq-block]") : null;
    const after = focused?.dataset.nqBlock ?? Array.from(root.querySelectorAll<HTMLElement>("[data-nq-block]")).filter(el => root.contains(el)).at(-1)?.dataset.nqBlock;
    if (!after || !liveTree(editor.view).alive.has(after)) return;
    const result = editor.commands.run("nooq.doc.import", { blocks: pluginsImportMarkdown(text), after });
    if (result.status === "failed") fail(undefined, result.error);
    else if (result.status === "denied") fail(undefined, new AuthorizationError(result.reason, result.retryable));
    else event.preventDefault();
  };
  
  root.addEventListener("paste", onPaste, { signal: surfaceAbort.signal });
  let renderState: DocState | undefined;
  let snapshotCache: { revision: number; value: Immutable<DocState> } | undefined;
  const fail = (plugin: string | undefined, cause: unknown) => editor.reportError({ plugin, phase: "view", cause });
  const snapshot = () => {
    // renderState is a fresh throwaway per render (EB-6): freeze in place —
    // the clone cost ~1.4ms per keystroke in the render microtask.
    if (snapshotCache?.revision !== editor.revision) {
      const state = renderState ?? editor.view;
      // EB-6/8: the maintained projection is frozen AT BUILD (O(changed));
      // freezing the shared state here again was fine when renders owned a
      // throwaway — with the projection it froze live state and broke writes.
      const alreadyFrozen = state.roots.length === 0 || Object.isFrozen(state.roots[0]);
      snapshotCache = { revision: editor.revision, value: alreadyFrozen ? state : freezeInPlace(state) };
    }
    return snapshotCache.value;
  };
  // §7 surface hooks (the drag handle): invoked once, after the root exists
  // and the surface is otherwise assembled; cleanups run on destroy.
  for (const { plugin: pluginId, hook } of surfaceHooks.splice(0)) {
    try {
      const cleanup = hook({ root, signal: surfaceAbort.signal, snapshot, run: (command, args) => { try { return editor.commands.run(command, args); } catch (cause) { fail(pluginId, cause); return { status: "failed" as const, error: cause }; } }, onChange: listener => { const off = editor.onChange(() => { if (!destroyed) listener(); }); surfaceCleanups.push(off); return off; }, report: cause => fail(pluginId, cause) });
      if (cleanup) surfaceCleanups.push(cleanup);
    } catch (cause) { fail(pluginId, cause); }
  }
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
  /** SW-7: where this writer's caret and selection sit, from the document selection or the focused text host. */
  const localCursor = (): CursorAnchor | undefined => {
    const range = documentSelection?.service.get();
    if (range) return { ...range.head, ...(range.anchor.block !== range.head.block || range.anchor.offset !== range.head.offset ? { anchor: { ...range.anchor } } : {}) };
    const active = document.activeElement, id = active?.closest<HTMLElement>("[data-nq-block]")?.dataset.nqBlock;
    const binding = id !== undefined ? rows.get(id)?.bindings.find(b => b.element.contains(active)) : undefined;
    if (!binding) return;
    const { anchor, head } = binding.selection();
    return { block: id!, offset: head, ...(anchor !== head ? { anchor: { block: id!, offset: anchor } } : {}) };
  };
  let published: string | undefined, publishScheduled = false;
  const publishCursor = () => {
    if (publishScheduled || destroyed || !editor.hasTransport) return;
    publishScheduled = true;
    queueMicrotask(() => {
      publishScheduled = false; if (destroyed) return;
      const cursor = localCursor(), key = cursor && JSON.stringify(cursor);
      if (cursor && key !== published) { published = key; editor.setCursor(cursor); }
    });
  };
  const selected = () => { formatToolbar.reconcile(); refreshActions(); publishCursor(); };
  for (const type of ["select", "focusin", "keyup", "mouseup"]) root.addEventListener(type, selected, { signal: surfaceAbort.signal });
  // Away clear #1: focus moves into the block's row — the writer is looking
  // at it. Resolution mirrors localCursor: the row shell's data-nq-block.
  root.addEventListener("focusin", (event) => {
    const block = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-nq-block]")?.dataset.nqBlock : undefined;
    if (block !== undefined) away.clear(block); // a flip, if any, re-syncs the shell via onFlip — no render needed
  }, { signal: surfaceAbort.signal });
  // The strip's pointer policy: only a primary-button mouseup that completes
  // a selection can summon it — never typing, never keyboard-only selection.
  root.addEventListener("mouseup", event => formatToolbar.pointerUp(event), { signal: surfaceAbort.signal });
  // The interactive change bar's contract: a view's blockRow dispatches one
  // bubbling `nq:block-history` event from the bar (via onHistory); the host
  // opens the popover, because only it sees the history store and the inks.
  root.addEventListener("nq:block-history", (event) => {
    const bar = event.target;
    if (!(bar instanceof HTMLElement)) return;
    const block = bar.closest<HTMLElement>("[data-nq-block]")?.dataset.nqBlock;
    if (block === undefined || !liveTree(editor.view).alive.has(block)) return;
    away.clear(block); // away clear #3: opening the block's history is seeing its past
    void openBlockHistory(editor, bar, block, presence).catch(cause => editor.reportError({ phase: "view", cause }));
  }, { signal: surfaceAbort.signal });
  root.ownerDocument.addEventListener("selectionchange", () => {
    formatToolbar.reconcile(); // the strip follows the selection even when focus left the surface
    if (root.contains(root.ownerDocument.activeElement)) selected();
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
        // §2a: the structured denial carries retryable through to the notice
        // layer — a hold is a hold, not a flattened Error(reason).
        if (result.status === "denied") throw new AuthorizationError(result.reason, result.retryable);
        return result.status === "applied";
      }
      editor.applyTextChanges(id, changes); return true;
    } catch (cause) { fail(undefined, cause); return false; }
  }
  function keyDown(id: string, event: KeyboardEvent): boolean {
    if (typeof process !== "undefined" && process.env.NQ_DEBUG_KEYS) console.log("[keyDown]", id, event.key, "actions:", (keys.get([event.ctrlKey ? "Ctrl" : "", event.metaKey ? "Meta" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.key].filter(Boolean).join("+")) ?? []).map((a) => a.id).join(","));
    if (event.key === "Escape") { closeMenu(); formatToolbar.hide(); return true; }
    // Mod-k is the writer-facing link chord (0009 §5): one popover over the
    // selection, before any plugin key binding could claim the same chord.
    if (links.keyDown(id, event)) return true;
    const key = [event.ctrlKey ? "Ctrl" : "", event.metaKey ? "Meta" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.key].filter(Boolean).join("+");
    for (const action of keys.get(key) ?? []) try {
      const outcome = invoke(action, id);
      if (typeof process !== "undefined" && process.env.NQ_DEBUG_KEYS) console.log("[invoke]", action.id, "->", outcome.status, JSON.stringify(outcome).slice(0, 200));
      if (outcome.status !== "not-applicable" && outcome.status !== "unavailable") return true;
    } catch (cause) { fail(undefined, cause); return true; }
    return false;
  }
  function mountRichText(id: string, row: Row, options?: RichTextSurfaceOptions, input?: { keyDown(event: KeyboardEvent): boolean; beforeInput(event: InputEvent): boolean }) {
    if (row.bindings.length) throw new Error(`View ${id} mounted more than one text controller`);
    const rich = createRichText({ read: () => editor.view.blocks[id]?.text ?? { s: "", marks: [] },
      // The block's fields ride the update path so payloaded spans re-render when their entries change (0009 §1).
      fields: () => editor.view.blocks[id]?.fields ?? {},
      commit: changes => sendText(id, row, changes), keyDown: event => input ? input.keyDown(event) : keyDown(id, event),
      beforeInput: event => input?.beforeInput(event) ?? false,
      input: text => { if (text === "/") openMenu(id); else closeMenu(); },
    }, options);
    row.bindings.push({ ...rich, marks: options?.marks ?? ["strong", "em", "code"], update: block => rich.update(block.text ?? { s: "", marks: [] }, block.fields) });
    return rich;
  }
  function mountText(id: string, row: Row, label = "Text block", input?: { keyDown(event: KeyboardEvent): boolean; beforeInput(event: InputEvent): boolean }): Binding & TextBinding {
    if (row.bindings.length) throw new Error(`View ${id} mounted more than one text controller`);
    // The host ships unstyled: the Document type class carries the typography.
    const area = document.createElement("textarea"); area.className = "nq-input nq-doc-body"; area.setAttribute("aria-label", label);
    let value = (renderState ?? editor.view).blocks[id]?.text?.s ?? "", compositionBase = value;
    area.value = value;
    // The empty-block hint rides the native placeholder: present only while
    // the block is empty, gone with the first admitted character.
    const syncPlaceholder = () => { if (value === "") area.setAttribute("placeholder", "Type / for blocks"); else area.removeAttribute("placeholder"); };
    syncPlaceholder();
    const controller = new AbortController();
    const send = (changes: TextChange[]) => {
      if (!changes.length) return;
      const accepted = sendText(id, row, changes);
      value = editor.view.blocks[id]?.text?.s ?? "";
      if (!accepted) area.value = value;
      syncPlaceholder();
    };
    const binding: Binding & TextBinding & { composing: boolean } = { element: area, composing: false,
      selection: () => ({ anchor: area.selectionDirection === "backward" ? area.selectionEnd : area.selectionStart, head: area.selectionDirection === "backward" ? area.selectionStart : area.selectionEnd }),
      focus(selection) { if (controller.signal.aborted) return; area.focus({ preventScroll: true }); if (selection) area.setSelectionRange(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head), selection.anchor > selection.head ? "backward" : "forward"); },
      insertText(text) {
        if (controller.signal.aborted || binding.composing) return false;
        const from = area.selectionStart, to = area.selectionEnd, direction = area.selectionDirection, before = area.value;
        const accepted = sendText(id, row, [{ retain: from }, { delete: to - from }, { insert: text }]);
        area.value = value = editor.view.blocks[id]?.text?.s ?? "";
        syncPlaceholder();
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
        } value = next; syncPlaceholder();
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
      area.value = value; syncPlaceholder(); area.setSelectionRange(from + inserted.length, from + inserted.length);
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
      else if (result.status === "denied") fail(undefined, new AuthorizationError(result.reason, result.retryable)); // §2a: retryable survives to the notice layer
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
    // Toggle authoring stays the reserved trio (0009 §2); payloaded and plugin bases
    // arrive through commands and renderers, never toggle formatting. The policy's
    // renderMarks build this surface's schema for them (0009 §3).
    binding = mode === "rich" ? { ...mountRichText(id, row, { label, marks: (policy.marks ?? []).filter((mark): mark is TextMark => (["strong", "em", "code"] as readonly string[]).includes(mark)), ...(policy.renderMarks ? { renderMarks: policy.renderMarks } : {}) }, input), mode }
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
    jobs.unmount(row.id);
    links.closeFor(row.id); // an open link editor never outlives its block's row
    formatToolbar.hideFor(row.id); // neither does the strip shown over its selection
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
  const stats = { remoteRenders: 0, pins: 0, lastAnchor: null as string | null, lastDrift: 0, lastAnchorRect: null as { top: number; bottom: number } | null, lastViewportTop: 0, renderCounts: { targeted: 0, full: 0, presence: 0, windowed: 0 } };
  // EB-7.2: a browser cannot scroll before zero or past its new document
  // end. Preserve the missing extent locally until the writer navigates.
  let leadingSpace = 0, trailingSpace = 0;
  let pinnedScroll: number | undefined;
  const releaseViewportSpace = () => {
    if (!leadingSpace && !trailingSpace) return;
    leadingSpace = trailingSpace = 0;
    pinnedScroll = undefined;
    body.style.paddingTop = ""; history.style.paddingBottom = "";
  };
  window.addEventListener("wheel", releaseViewportSpace, { passive: true, signal: surfaceAbort.signal });
  window.addEventListener("touchmove", releaseViewportSpace, { passive: true, signal: surfaceAbort.signal });
  root.addEventListener("keydown", event => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].includes(event.key)) releaseViewportSpace();
  }, { signal: surfaceAbort.signal });

  /** EB-7.2: start at a genuinely visible old row, then choose its fallback.
   *  Choose from the old DOM before rendering: a changed/deleted top block
   *  yields to the nearest unchanged block below it, across the whole batch. */
  function pickAnchor(changed: ReadonlySet<string>, alive: ReadonlySet<string>): { row: HTMLElement; top: number } | null {
    const scroller = document.scrollingElement;
    if (!scroller) return null;
    // Rects are viewport-relative: the visible top is 0. (The scroller's own
    // rect top is NOT a proxy — a scrolling <html> reports -scrollY, which
    // once admitted rows 800px above the viewport; measured, not assumed.)
    let visibleOrigin = false;
    for (const shell of Array.from(body.querySelectorAll<HTMLElement>("[data-nq-block]"))) {
      const id = shell.dataset.nqBlock!;
      // History rows and aggregate windowing placeholders are not live
      // block anchors. Descendants of a deleted block are excluded by alive.
      if (rows.get(id)?.shell !== shell) continue;
      const rect = shell.getBoundingClientRect();
      // The origin may just have been deleted. Its old DOM still defines
      // what was visible; only the surviving fallback needs to be alive.
      if (!visibleOrigin) {
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
        visibleOrigin = true;
      }
      if (rect.bottom > 0 && alive.has(id) && !changed.has(id)) return { row: shell, top: rect.top };
    }
    return null;
  }
  function pinViewport(anchor: { row: HTMLElement; top: number } | null): void {
    if (!anchor || !anchor.row.isConnected) return;
    const scroller = document.scrollingElement;
    if (!scroller) return;
    const drift = anchor.row.getBoundingClientRect().top - anchor.top;
    stats.lastDrift = drift;
    if (drift === 0) { pinnedScroll = scroller.scrollTop; return; }
    const target = scroller.scrollTop + drift;
    if (target < 0) {
      leadingSpace -= target;
      body.style.paddingTop = `${leadingSpace}px`;
    } else {
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (target > max) {
        trailingSpace += target - max;
        history.style.paddingBottom = `${trailingSpace}px`;
      }
    }
    scroller.scrollTop = Math.max(0, target);
    pinnedScroll = scroller.scrollTop;
    stats.pins++;
  }

  // ---- EB-8 windowing: mount only what the viewport needs -----------------
  // Estimated row height drives placeholder sizing; measured rows correct it.
  let lastWindowAt = -Infinity, scrollSignal: AbortController | undefined;
  /** Measured heights by id (EB-8): every render measures its mounted rows;
   *  estimates converge to reality as blocks are visited, so placeholder
   *  heights and window decisions stop drifting from the real document. */
  const heightCache = new Map<string, number>();
  const gaps = new Map<HTMLElement, { top?: HTMLElement; bottom?: HTMLElement }>();
  /** Subtree estimates, persistent across renders (EB-6): structural
   *  keystrokes pay full renders; rebuilding 2k estimates each time was
   *  most of it. Cleared when structure or measured heights change. */
  const estMemo = new Map<string, number>();
  const estimateOf = (id: string, block: { text?: { s: string }; children: readonly string[] }): number => {
    const measured = heightCache.get(id);
    if (measured !== undefined) return measured;
    const lines = Math.max(1, Math.ceil((block.text?.s.length ?? 0) / 90));
    return 8 + lines * 21 + (block.children.length ? 4 : 0);
  };
  const measureMounted = (): void => {
    for (const [id, row] of rows) {
      const h = row.shell.getBoundingClientRect().height;
      if (h > 0 && h !== heightCache.get(id)) { heightCache.set(id, h); invalidateSubtree(id); }
    }
  };
  const invalidateSubtree = (id: string): void => {
    if (estMemo.delete(id)) {
      const block = (renderState ?? editor.view).blocks[id];
      if (block) for (const child of block.children) invalidateSubtree(child);
    }
  };
  const visibleWindow = (): [number, number] => {
    const vh = window.innerHeight || 800, top = window.scrollY || 0;
    return [top - 2 * vh, top + 2 * vh]; // two screens of overscan each way (EB-8)
  };
  function onScroll(): void {
    if (destroyed) return;
    // Scrollbar/host navigation also releases retained space. Scroll events
    // from our own pin land at pinnedScroll and keep the remote anchor intact.
    if (!batchIsRemote && pinnedScroll !== undefined && Math.abs(window.scrollY - pinnedScroll) >= 1) releaseViewportSpace();
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (destroyed) return;
      if (Math.abs((window.scrollY || 0) - lastWindowAt) < (window.innerHeight || 800) / 2) return;
      lastWindowAt = window.scrollY || 0;
      render();
    });
  }
  // (EB-8 v1: placeholder drift anchoring is a named follow-up — the focused-row
  // pin and measured-height cache carry typing; jump-scroll alignment needs a
  // measurement cache the walk itself consumes.)
  scrollSignal?.abort();
  scrollSignal = new AbortController();
  window.addEventListener("scroll", onScroll, { passive: true, signal: scrollSignal.signal });

  // EB-7.1: capture real character identities BEFORE merging. String diffs
  // cannot locate a deletion among repeated characters or choose range affinity.
  let remoteSelection: { block: string; element: HTMLElement; anchor: Y.RelativePosition; head: Y.RelativePosition; order: string[]; transaction: Y.Transaction } | undefined;
  let nativeComposing = false;
  root.addEventListener("compositionstart", () => { nativeComposing = true; }, { signal: surfaceAbort.signal });
  root.addEventListener("compositionend", () => { nativeComposing = false; }, { signal: surfaceAbort.signal });
  const captureRemoteSelection = (transaction: Y.Transaction) => {
    if (transaction.local || remoteSelection || nativeComposing || destroyed) return;
    const row = [...rows.values()].find(row => row.bindings.some(binding => binding.element.contains(document.activeElement)));
    const binding = row?.bindings.find(binding => binding.element.contains(document.activeElement));
    const text = row && layout(editor.ydoc).blocks.get(row.id)?.get("text");
    if (!row || !binding || !(text instanceof Y.Text)) return;
    const selection = binding.selection(), low = Math.min(selection.anchor, selection.head);
    const relative = (position: number) => Y.createRelativePositionFromTypeIndex(text, position,
      selection.anchor !== selection.head && position === low ? 0 : -1);
    remoteSelection = { block: row.id, element: binding.element, anchor: relative(selection.anchor), head: relative(selection.head), order: textBlockOrder(editor.view), transaction };
  };
  const releaseEmptySelection = (transaction: Y.Transaction) => {
    if (remoteSelection?.transaction === transaction && transaction.changed.size === 0) remoteSelection = undefined;
  };
  editor.ydoc.on("beforeTransaction", captureRemoteSelection);
  editor.ydoc.on("afterTransaction", releaseEmptySelection);

  function render() {
    documentSelection?.beforeRender();
    scheduled = false; if (destroyed) return;
    rendering = true;
    const batch = pendingBatch; const remote = batchIsRemote;
    pendingBatch = null; batchIsRemote = false;
    // Keep every touched block even if roots/access below switches the
    // renderer to a full walk. Later events can invalidate fallback rows too.
    const touched = new Set(batch?.flatMap(event => event.blocks));
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
    const state = editor.view, alive = liveTree(state).alive;
    const anchor = remote ? pickAnchor(touched, alive) : null;
    stats.lastAnchor = anchor?.row.getAttribute("data-nq-block") ?? null;
    if (anchor) {
      stats.lastAnchorRect = { top: Math.round(anchor.row.getBoundingClientRect().top), bottom: Math.round(anchor.row.getBoundingClientRect().bottom) };
      stats.lastViewportTop = Math.round((document.scrollingElement as HTMLElement | null)?.getBoundingClientRect().top ?? 0);
    }
    try {
    const wanted = new Set<string>();
    renderState = state;
    const active = [...rows.values()].flatMap(row => row.bindings).find(binding => binding.element.contains(document.activeElement));
    const activeSelection = active?.selection();
    const tracked = remoteSelection?.element.contains(document.activeElement) ? remoteSelection : undefined; remoteSelection = undefined;
    let remoteFocus: SelectionRequest | undefined;
    if (tracked) {
      if (alive.has(tracked.block)) {
        const anchor = Y.createAbsolutePositionFromRelativePosition(tracked.anchor, editor.ydoc);
        const head = Y.createAbsolutePositionFromRelativePosition(tracked.head, editor.ydoc);
        if (anchor && head) remoteFocus = { block: tracked.block, anchor: anchor.index, head: head.index };
      } else {
        const at = tracked.order.indexOf(tracked.block);
        const next = tracked.order.slice(at + 1).find(id => alive.has(id) && state.blocks[id]?.text !== undefined);
        const previous = tracked.order.slice(0, at).reverse().find(id => alive.has(id) && state.blocks[id]?.text !== undefined);
        const block = next ?? previous ?? textBlockOrder(state)[0];
        if (block) {
          const offset = next || !previous ? 0 : state.blocks[block]?.text?.s.length ?? 0;
          remoteFocus = { block, anchor: offset, head: offset };
        }
      }
    }
    const focusedBlock = remoteFocus?.block ?? [...rows.values()].find(row => row.bindings.includes(active!))?.id;
    const anchorBlock = anchor?.row.dataset.nqBlock;
    const peers = [...editor.awareness.values()];
    status.replaceChildren(syncStatus({ state: editor.hasTransport ? editor.synced ? "synced" : "syncing" : "local", count: editor.awareness.size }), surfaceStatus.element);
    surfaceStatus.update(peers);
    // EB-8 windowing: placeholders carry unmounted subtrees' estimated
    // height; the walk is O(doc) iteration + O(visible) DOM work.
    const estSubtree = (id: string): number => {
      const memo = estMemo.get(id); if (memo !== undefined) return memo;
      const block = state.blocks[id];
      const total = block ? estimateOf(id, block) + block.children.reduce((n, child) => n + estSubtree(child), 0) : 0;
      estMemo.set(id, total);
      return total;
    };
    const [winTop, winBottom] = visibleWindow();
    lastWindowAt = window.scrollY || 0;
    // Structural change: invalidate only the CHANGED subtrees — a split
    // moves one block, not the document (a full clear rebuilt 2k estimates
    // and owned the ~90ms structural-keystroke tail). Ancestor sums drift by
    // at most a row height; the two-screen overscan absorbs it until the
    // next measurement corrects.
    if (changedIds !== null) for (const id of changedIds) invalidateSubtree(id);
    else if (structural) estMemo.clear(); // whole-document structure moved
    let walkY = leadingSpace;
    /**
     * Two reusable gap placeholders per container (EB-8): the window is
     * contiguous, so at most one gap above the mounted run and one below.
     * Elements persist across renders and only their heights update — the
     * per-render create/delete version stopped a 33M-pixel height leak but
     * churned layout; a div per skipped block was 9,953 elements at ref-huge.
     */
    const gapSums = new Map<HTMLElement, number>();
    const usedGaps = new Set<HTMLElement>();
    const gapFor = (parent: HTMLElement, which: "top" | "bottom", id: string, at: number): { el: HTMLElement; height: number } => {
      let pair = gaps.get(parent);
      if (!pair) { pair = {}; gaps.set(parent, pair); }
      if (!pair[which]) {
        const el = document.createElement("div");
        el.setAttribute("data-nq-ph", "1");
        el.style.pointerEvents = "auto";
        el.addEventListener("click", () => { el.scrollIntoView({ block: "center" }); requestAnimationFrame(() => requestAnimationFrame(() => render())); }, { signal: surfaceAbort.signal });
        pair[which] = el;
      }
      const el = pair[which]!;
      if (!usedGaps.has(el)) el.setAttribute("data-nq-block", id);
      return { el, height: 0 };
    };
    const walk = (ids: readonly string[], parent: HTMLElement) => {
      let at = 0;
      for (const id of ids) {
        const block = state.blocks[id]; if (!block || wanted.has(id)) continue;
        const est = estSubtree(id);
        const mounted = rows.get(id);
        if (!mounted && id !== focusedBlock && id !== anchorBlock && (walkY + est < winTop || walkY > winBottom)) {
          // Outside the window and never mounted: accumulate into the gap.
          const which: "top" | "bottom" = walkY + est < winTop ? "top" : "bottom";
          const gap = gapFor(parent, which, id, at);
          gap.height += est;
          gapSums.set(gap.el, (gapSums.get(gap.el) ?? 0) + est);
          usedGaps.add(gap.el);
          walkY += est;
          continue;
        }
        if (mounted && id !== focusedBlock && id !== anchorBlock && walkY + est < winTop - (window.innerHeight || 800) && !mounted.bindings.some(b => b.element.contains(document.activeElement))) {
          // Mounted but far above the window: release it — never the focused
          // row (it is by definition visible; estimate drift must not eat it).
          cleanup(mounted); mounted.shell.remove(); rows.delete(id);
          const gap = gapFor(parent, "top", id, at);
          gapSums.set(gap.el, (gapSums.get(gap.el) ?? 0) + est);
          usedGaps.add(gap.el);
          walkY += est;
          continue;
        }
        const stalePh = parent.children[at];
        if (stalePh instanceof HTMLElement && stalePh.getAttribute("data-nq-ph") === "1") stalePh.remove();
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
        // The presence overlay places carets in rich text; a textarea or text-less view shows its peers as a chip.
        // Chips carry each writer's derived ink (peerInk, like the overlay) and appear only once it resolves.
        const chips = row.bindings[0]?.marks === undefined ? peers.flatMap(peer => {
          const ink = presence.inkOf(peer.actor);
          return ink && peer.cursor?.block === id ? [presenceCaret({ name: peer.name ?? peer.actor, ink })] : [];
        }) : [];
        row.presence.replaceChildren(...chips);
        if (parent.children[at] !== row.shell) parent.insertBefore(row.shell, parent.children[at] ?? null);
        jobs.mount(row.shell, id); // every render re-placed: active job surfaces re-attach with their block
        applyAway(row); // away marks ride the walk: a marked block mounts notched — mounting itself never clears
        at++; walkY += estimateOf(id, block); walk(block.children, row.children);
      }
    };
    walk(state.roots, body);
    if (structural || changedIds === null) {
      const historic: string[] = [];
      for (const plugin of plugins) try { historic.push(...plugin.history?.(snapshot()) ?? []); } catch (cause) { fail(plugin.id, cause); }
      // The panel renders the RECENT tail of the store (DM-14.4): a long
      // session's history grows without bound, and rendering every dead block
      // per structural change went quadratic — 10k fuzz ops exceeded 20
      // minutes. The store keeps everything; the surface shows the last 200.
      const recent = historic.slice(-200);
      // Dead blocks draw two ways: a view that keeps its own history (the
      // settled suggestion card) still mounts; everything else renders as the
      // deleted BlockRow with Restore (DM-3.4) instead of the generic fallback.
      const dead = recent.filter(id => !alive.has(id));
      walk(dead.filter(id => viewKeepsHistory(views.get(state.blocks[id]?.type ?? ""))), history);
      historyLayer.update(dead.filter(id => !viewKeepsHistory(views.get(state.blocks[id]?.type ?? ""))));
    }
    for (const [id, row] of rows) if (!wanted.has(id)) { cleanup(row); row.shell.remove(); rows.delete(id); }
    away.prune(alive); // deletion ends a block's marks (session-local); unmounting alone never does — windowed-out rows keep theirs
    for (const [parent, pair] of gaps) {
      if (!root.contains(parent)) {
        pair.top?.remove(); pair.bottom?.remove(); gaps.delete(parent); continue;
      }
      for (const which of ["top", "bottom"] as const) {
        const el = pair[which];
        if (!el) continue;
        if (!usedGaps.has(el)) { el.remove(); pair[which] = undefined; continue; }
        el.style.height = `${Math.max(1, Math.round(gapSums.get(el) ?? 0))}px`;
        // position: the top gap sits before the first mounted row, the bottom
        // gap after the last — rows insert positionally, gaps bracket them.
        if (which === "top") parent.prepend(el);
        else parent.append(el);
      }
    }
    stats.renderCounts.windowed = rows.size;
    presence.update(state, peers);
    if (rows.size) { measureMounted(); away.arm(); superseded.arm(); } // both detectors arm with the first content render: the open state is neither away nor raced — replayed history fires nothing
    // EB-5: editable in the frame the surface becomes visible — no clicking.
    if (!mountedFocused && root.isConnected) {
      mountedFocused = true;
      if (!root.contains(document.activeElement)) {
        const first = [...rows.values()].find((row) => alive.has(row.id) && row.bindings[0]);
        const caret = state.blocks[first?.id ?? ""]?.text?.s.length ?? 0;
        first?.bindings[0]?.focus({ anchor: caret, head: caret });
      }
    }
    if (!(globalThis as { __nqFirstRender?: boolean }).__nqFirstRender) { (globalThis as { __nqFirstRender?: boolean }).__nqFirstRender = true; try { performance.mark("nq:first-render"); } catch { /* non-browser */ } }
    if (active && root.contains(active.element) && !active.element.contains(document.activeElement)) active.focus(activeSelection);
    if (remoteFocus) rows.get(remoteFocus.block)?.bindings[0]?.focus(remoteFocus);
    else if (tracked && !alive.has(tracked.block)) { root.tabIndex = -1; root.focus({ preventScroll: true }); }
    if (pendingSelection) {
      const request = pendingSelection; pendingSelection = undefined;
      const binding = rows.get(request.block)?.bindings[0];
      if (binding && alive.has(request.block)) binding.focus(request);
    }
    if (anchor) {
      pinViewport(anchor);
      // EB-7.2: our own scroll must not immediately rewindow using a new
      // origin and undo the fallback pin, including a fallback below screen.
      lastWindowAt = window.scrollY || 0;
    }
    for (const refresh of actionRefreshers) refresh();
    if (menuBlock) {
      if (alive.has(menuBlock) && state.blocks[menuBlock]?.text?.s === "/") openMenu(menuBlock);
      else closeMenu();
    }
    } finally {
      rendering = false; renderState = undefined; documentSelection?.afterRender();
      // The open state ends with the first render, whatever it drew — the
      // loader must never outlive content (or the error that replaced it).
      if (!firstRenderDone) { firstRenderDone = true; settleLoading(); }
    }
  }
  // EB-6: render only what the transactions touched; a null set means all.
  let pendingBatch: import("@nooq/plugins").ChangeEvent[] | null = null;
  let batchIsRemote = false;
  const offEvents = editor.onEvents((events) => {
    pendingBatch = pendingBatch === null ? [...events] : [...pendingBatch, ...events];
    for (const event of events) away.observe(event); // away: remote+unmounted marks; a local edit is a visit and clears (away clear #2)
    if (events.some((event) => event.origin === "remote")) batchIsRemote = true;
  });
  const documentSelection = options.selectionMode === "document" ? createDocumentSelection(editor, root, () => new Map(
    [...rows].flatMap(([id, row]) => row.bindings[0] ? [[id, { ...row.bindings[0], marks: row.bindings[0].marks ?? null }] as const] : []),
  ), () => destroyed || rendering) : undefined;
  if (documentSelection) { root.classList.add("nq-document-selection"); root.tabIndex = -1; root.dataset.nqDocumentSelection = "true"; }
  const offChange = editor.onChange(schedule), offSelection = editor.onSelection(request => { pendingSelection = request; schedule(); });
  // The error channel made visible (foundation: Notice) — one non-blocking
  // notice above the document naming the actor and the phase; a newer error
  // replaces it, Dismiss clears it, and it never sits on the input path.
  // §2a: authorization facts read as what they are — a denial (kind
  // "denial") or a retryable hold (kind "hold"), word = the reason verbatim.
  // The generic error notice stays for real errors.
  const showNotice = (kind: "error" | "hold" | "denial" | "superseded", word: string, action: NoticeAction = { label: "Dismiss", onClick: () => notices.replaceChildren() }) => {
    if (surfaceAbort.signal.aborted) return;
    notices.replaceChildren(notice({ kind, word, action }));
  };
  const offErrors = editor.onError(error => {
    const cause = error.cause;
    if (cause instanceof AuthorizationError) { showNotice(cause.retryable ? "hold" : "denial", cause.reason); return; }
    if (cause instanceof SessionError && cause.code === "envelope-denied") { showNotice("denial", cause.message); return; } // the local writer's envelope, refused by the relay
    const who = error.plugin ?? "The editor";
    const what = cause instanceof Error ? cause.message : String(cause);
    showNotice("error", `${who} failed in ${error.phase}: ${what}`);
  });
  // §2a: session admission verdicts — a denied or held envelope says so in
  // its own words. An allow is the silent majority. Same notice channel as
  // errors: one notice at a time, latest wins.
  const offAdmissions = editor.onAdmission((verdict, reason) => {
    if (verdict === "allow") return;
    showNotice(verdict === "hold" ? "hold" : "denial", reason ?? (verdict === "hold" ? "held" : "denied"));
  });
  // DM-4.9: supersession notices ride the same channel (one notice at a
  // time, latest wins) as the new kind — a peer's move winning the register
  // is a fact about history, not a failure, so it gets no fill escalation.
  // The winner is named from awareness (name ?? actorId, the roster's rule).
  // "Move it anyway" is the one fresh move DM-4.9 allows — causally now, so
  // it wins through DM-4.7's ordinary resolution — and clicking it is also
  // the notice's dismissal; a delete that won the register gets DM-4.8's
  // wording and only Dismiss (reasserting into a tombstone is not offered).
  const superseded = createSupersededDetector(editor);
  const reassert = (event: SupersededEvent): void => {
    const move = event.losing.ops.find((op): op is Extract<Op, { op: "move" }> => op.op === "move" && op.block === event.block);
    if (!move) return;
    try {
      // One fresh move transaction to the losing move's original placement,
      // through the same authorized path every surface move takes.
      editor.applyOps([{ op: "move", block: event.block, newParent: move.newParent, ...(move.index !== undefined ? { index: move.index } : {}) }], "reassert-move");
    } catch (cause) {
      fail(undefined, cause); // a denial replaces this notice through the same channel (§2a)
      return;
    }
    notices.replaceChildren(); // one fresh move, the notice has said its piece
  };
  const offSuperseded = superseded.onEvent((event) => {
    const name = editor.awareness.get(event.winningActor)?.name ?? event.winningActor;
    if (event.deleted) {
      showNotice("superseded", `${name} deleted this block while you moved it.`);
      return;
    }
    showNotice("superseded", `${name} moved this block at the same time you did. Their move won.`, { label: "Move it anyway", onClick: () => reassert(event) });
  });
  // Signing readiness is the open state's other half (a rejected ready already
  // closes the editor and destroys the surface; clearing here keeps the two
  // paths from racing the host's teardown).
  const markReady = () => { readyForContent = true; settleLoading(); };
  void editor.ready.then(markReady, markReady);
  let offClose = () => {};
  const destroy = () => { if (destroyed) return; destroyed = true; for (const cleanup of surfaceCleanups.splice(0).reverse()) try { cleanup(); } catch { /* the surface is going away regardless */ } documentSelection?.destroy(); presence.destroy(); historyLayer.destroy(); surfaceStatus.destroy(); jobs.destroy(); away.destroy(); superseded.destroy(); links.destroy(); shortcuts.destroy(); formatToolbar.destroy(); surfaceAbort.abort(); editor.ydoc.off("beforeTransaction", captureRemoteSelection); editor.ydoc.off("afterTransaction", releaseEmptySelection); offEvents(); offChange(); offSelection(); offErrors(); offAdmissions(); offSuperseded(); offClose(); closeMenu(); loadHost.done(); for (const row of rows.values()) cleanup(row); rows.clear(); root.remove(); };
  offClose = editor.onClose(destroy); schedule();
  return { element: root, actions, keymap: keys, textMode, away, superseded, ...(documentSelection ? { selection: documentSelection.service } : {}), destroy, get remoteRenders() { return stats.remoteRenders; }, get pins() { return stats.pins; }, get lastAnchor() { return stats.lastAnchor; }, get lastDrift() { return stats.lastDrift; }, get lastAnchorRect() { return stats.lastAnchorRect; }, get lastViewportTop() { return stats.lastViewportTop; }, get renderCounts() { return stats.renderCounts; }, get mountedRows() { return rows.size; },
    estimateTop: (id: string): number => { let y = 0; const visit = (ids: readonly string[]): boolean => { for (const bid of ids) { const b = (renderState ?? editor.view).blocks[bid]; if (!b) continue; if (bid === id) return true; y += estimateOf(bid, b); if (visit(b.children)) return true; } return false; }; return visit((renderState ?? editor.view).roots) ? y : -1; } };
}
