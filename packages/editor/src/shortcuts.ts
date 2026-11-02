/**
 * The shortcut sheet (foundation P2): the keyboard reference, generated from
 * registered actions and keymaps so it can't drift. The collector reads the
 * surface's resolved key map — the same live map `keyDown` dispatches
 * through — and the "?" trigger opens the design popover anchored to the
 * surface root with the sheet inside. Reference UI, never the input path
 * (§3): typing "?" inside a text host keeps typing, and an active IME
 * composition is never interrupted.
 */
import { popover, shortcutSheet, type PopoverHandle } from "@nooq/design";
import type { EditorSurface } from "./dom.ts";

/** What one row shows: the action's label and every key string registered for it. */
export interface ShortcutEntry { label: string; keys: readonly string[] }
/** One titled section of the sheet. */
export interface ShortcutGroup { title: string; entries: readonly ShortcutEntry[] }

/**
 * The host's own text chords: rich-text.ts's `handleKeyDown` (Mod-b/i/`) and
 * link-ui.ts's reserved Mod-k. They are not registry bindings — the surface
 * resolves them before the key map — so the sheet carries them here, spelled
 * the way the surface resolves them (Ctrl and Meta both match the same Mod).
 * Listed only while the surface mounts rich text; plain hosts have no chords.
 */
const RICH_TEXT_CHORDS: readonly ShortcutEntry[] = [
  { label: "Bold", keys: ["Ctrl+B", "Meta+B"] },
  { label: "Italic", keys: ["Ctrl+I", "Meta+I"] },
  { label: "Code", keys: ["Ctrl+`", "Meta+`"] },
  { label: "Link", keys: ["Ctrl+K", "Meta+K"] },
];

/**
 * The sheet's groups, collected live from the surface's resolved key bindings
 * (`keymap`, built from plugin `keys`, shared actions' `keys` and `keyOrder`).
 * One row per registered action — an action with several keys shows every key
 * once — grouped by kind: the host's text chords, commands over blocks, and
 * job-starting tools. Availability is per block and varies while writing, so
 * the sheet lists the registry: it is the catalog of what each key does, not
 * a live menu.
 */
export function collectShortcuts(surface: Pick<EditorSurface, "keymap" | "textMode">): readonly ShortcutGroup[] {
  const commands = new Map<string, ShortcutEntry & { keys: string[] }>();
  const tools = new Map<string, ShortcutEntry & { keys: string[] }>();
  for (const bindings of surface.keymap.values()) {
    for (const binding of bindings) {
      const group = binding.job !== undefined ? tools : commands;
      let entry = group.get(binding.id);
      if (!entry) { entry = { label: binding.label, keys: [] }; group.set(binding.id, entry); }
      if (!entry.keys.includes(binding.key)) entry.keys.push(binding.key);
    }
  }
  const groups: ShortcutGroup[] = [];
  if (surface.textMode === "rich") groups.push({ title: "Text editing", entries: RICH_TEXT_CHORDS });
  if (commands.size > 0) groups.push({ title: "Block actions", entries: [...commands.values()] });
  if (tools.size > 0) groups.push({ title: "Tools", entries: [...tools.values()] });
  return groups;
}

export interface ShortcutSheetUI { destroy(): void }

/**
 * Wire the "?" trigger (Shift+/): opens the keyboard-reference popover
 * anchored to the surface root, refreshed from the live registry at open
 * time, so the sheet cannot drift. "?" again closes; Esc closes returning
 * focus (the popover's contract). "?" whose target is a text host or any
 * field is typing and never opens the sheet — a cross-block selection in
 * document mode consumes its keys before this trigger, so typing always wins.
 */
export function mountShortcutSheet(setup: {
  /** The surface root: the popover's anchor and where focus returns. */
  element: HTMLElement;
  /** The resolved key bindings, read live every time the sheet opens. */
  keymap: EditorSurface["keymap"];
  /** The surface's text presentation override; gates the host's text chords. */
  textMode: EditorSurface["textMode"];
  /** Torn down with the surface. */
  signal?: AbortSignal;
}): ShortcutSheetUI {
  const root = setup.element;
  // The popover returns focus to its anchor on close; the root must be able to take it.
  root.tabIndex = -1;
  let open: PopoverHandle | undefined;
  const close = (): void => { open?.destroy(); open = undefined; };
  const onKey = (event: KeyboardEvent): void => {
    // Shift+/ produces "?" — plain, with no other modifier; a composition in progress is never the trigger.
    if (event.key !== "?" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const target = event.target;
    // "?" inside a text host or any field is typing (§3): the sheet opens only from outside the input path.
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable], .nq-input")) return;
    // This surface's keys, and the page's when nothing else owns them; another surface's root is not ours.
    const owned = target instanceof Node && (root.contains(target) || open?.element.contains(target) || target === document.body || target === document.documentElement);
    if (!owned) return;
    event.preventDefault();
    if (open) { close(); return; } // "?" again closes
    const handle = popover({
      anchor: root,
      side: "bottom",
      content: shortcutSheet({ groups: collectShortcuts(setup) }),
      onClose: () => { if (open === handle) open = undefined; },
    });
    handle.element.setAttribute("aria-label", "Keyboard shortcuts");
    document.body.append(handle.element);
    open = handle;
  };
  document.addEventListener("keydown", onKey, setup.signal !== undefined ? { signal: setup.signal } : undefined);
  return { destroy: close };
}
