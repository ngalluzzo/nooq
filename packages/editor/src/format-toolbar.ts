/**
 * The formatting toolbar (foundation P1): the selection-anchored strip of
 * quiet toggles — Bold, Italic, Code — plus Link when the block's policy
 * admits it. The appearance policy is decided: POINTER ONLY — a mouseup
 * (button 0) that completes a non-collapsed selection inside a rich text
 * host. Typing never summons it and keyboard-only selection never does,
 * because a surface that reacts to keystrokes sits on the input path (§3).
 * It dismisses on Escape, when the selection collapses, or when it leaves
 * the shown host. Placement never covers the caret's line: above the
 * selection, flipping below on viewport collision — the popover's pure
 * computePlacement math — with position traveling as custom properties so
 * the theme owns every painted value (the popover's precedent).
 *
 * The strip is a pointer affordance, never a focus stop: mousedown on a
 * button is prevented (the selection survives the click) and the buttons
 * are not tab stops. Keyboard writers keep the complete chords — Mod-b,
 * Mod-i, Mod-` and Mod-k — which is why nothing here can intercept typing.
 */
import { button, computePlacement } from "@nooq/design";
import type { TextMark, TextSelection } from "@nooq/plugins/dom";
import type { Editor } from "./controller.ts";
import { baseOf } from "./mark-tokens.ts";
import { linkTokenOver } from "./link-ui.ts";

/** The toggle bases in strip order; labels are sentence-case words (content fundamentals). */
const TOGGLES: readonly { base: TextMark; label: string }[] = [
  { base: "strong", label: "Bold" },
  { base: "em", label: "Italic" },
  { base: "code", label: "Code" },
  { base: "strike", label: "Strikethrough" },
  { base: "underline", label: "Underline" },
  { base: "highlight", label: "Highlight" },
];
/** The reserved payloaded base the Link button opens (0009 §2/§5). */
const LINK_BASE = "link";

/** What the strip needs from one block's rich text binding — the same shape link-ui binds. */
export interface FormatHost {
  /** The rich text element: the strip's anchor; focus stays here. */
  anchor: HTMLElement;
  selection(): TextSelection;
  /** The existing mark path — the same one Mod-b flows through (rich-text.ts), never a second mechanism. */
  toggleMark(mark: TextMark): boolean;
  /** Toggle bases this binding's policy admits (strong/em/code only; a payloaded base never toggles, 0009 §2). */
  marks?: readonly string[];
  /** DM-3.2: the block's fields, so the alignment control reads current state. */
  blockFields?: () => Record<string, unknown>;
  /** Runs a command (the alignment control writes the align field). */
  runCommand?: (id: string, args: unknown) => unknown;
}

export interface FormatToolbarSetup {
  /** Where the strip mounts: the surface root, so placement is root-relative. */
  mount: HTMLElement;
  report(cause: unknown): void;
  /** The block whose rich host wholly holds a non-collapsed document selection, when one does. */
  selectionBlock(): string | undefined;
  /** The rich text binding for a block, when one is mounted and connected. */
  host(id: string): FormatHost | undefined;
  /** The block's full policy bases (link admission) — the same source link-ui checks. */
  policyBases(id: string): readonly string[] | undefined;
  /** The Mod-k popover flow (link-ui), opened from the Link button; the two entrances share one flow. */
  openLink(id: string): boolean;
}

export interface FormatToolbarUI {
  /** The pointer policy: a mouseup (button 0) completing a selection in a rich host shows; anything else hides. */
  pointerUp(event: MouseEvent): void;
  /** Re-check the dismissal rules against the document selection; refresh pressed states when the strip stays. */
  reconcile(): void;
  /** Hide now (Escape, teardown). */
  hide(): void;
  /** Forget the strip for a block whose row is going away; silent when another block is shown. */
  hideFor(id: string): void;
  destroy(): void;
}

export function createFormatToolbar(editor: Editor, setup: FormatToolbarSetup): FormatToolbarUI {
  const element = document.createElement("div");
  element.className = "nq-format";
  element.setAttribute("role", "toolbar");

  /** The alignment control: three buttons, one field write — current state
   *  from the block, the press never moves focus (the strip's discipline). */
  let alignButtons: HTMLButtonElement[] | undefined;
  const buildAlign = (host: FormatHost): void => {
    if (alignButtons === undefined && host.blockFields !== undefined && host.runCommand !== undefined) {
      alignButtons = (["left", "center", "right"] as const).map(align => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.align = align;
        button.setAttribute("aria-label", `Align ${align}`);
        button.textContent = align === "left" ? "⇤" : align === "center" ? "↔" : "⇥";
        button.tabIndex = -1; // pointer affordance only (§3) — the toggles' discipline
        button.addEventListener("pointerdown", event => event.preventDefault());
        button.addEventListener("click", () => {
          const block = setup.selectionBlock();
          if (block === undefined) return;
          const current = host.blockFields?.().align;
          void host.runCommand?.("nooq.field.set", { block, key: "align", value: current === align ? "left" : align });
        });
        return button;
      });
      for (const button of alignButtons) element.append(button);
    }
  };
  element.setAttribute("aria-label", "Formatting");
  element.hidden = true;
  setup.mount.append(element);
  let shown: { block: string } | undefined;
  /** The range the strip was shown for. A toggle click re-renders the host and the binding's selection blinks collapsed; the writer's selection — kept by the press's preventDefault — is this one until a real selection replaces it. */
  let shownRange: { from: number; to: number } | undefined;
  /** True only inside a button's synchronous action: the toggle's own dispatch re-fires selection events (happy-dom dispatches them inline), and those must not read as the writer changing the selection. */
  let acting = false;
  /** One microtask of dedup for deferred reconciliation. */
  let reconcileQueued = false;
  /** Stable buttons, like the action toolbar: same order, no rebuild churn across selections. */
  const buttons = new Map<string, HTMLButtonElement>();

  /** The strip's buttons for one admitted set: toggles in TOGGLES order, then Link. */
  function render(host: FormatHost, linkAdmitted: boolean): void {
    buildAlign(host); // the segmented control, once; state refreshes below
    const wanted: string[] = TOGGLES.filter(({ base }) => host.marks?.includes(base)).map(({ base }) => base);
    if (linkAdmitted) wanted.push(LINK_BASE);
    for (const [base, el] of buttons) if (!wanted.includes(base)) { el.remove(); buttons.delete(base); }
    for (const base of wanted) {
      if (buttons.has(base)) continue;
      const label = base === LINK_BASE ? "Link" : TOGGLES.find(t => t.base === base)!.label;
      const el = button({ label, variant: "quiet" });
      el.dataset.nqBase = base;
      el.tabIndex = -1; // never a tab stop: the chords are the keyboard path, the strip the pointer path
      // The action toolbar's discipline: the press never moves focus, so the selection survives the click.
      el.addEventListener("mousedown", event => { if (event.button === 0) event.preventDefault(); });
      el.addEventListener("click", () => {
        if (!shown) return;
        const at = shown;
        const current = setup.host(at.block);
        if (!current) { hide(); return; }
        acting = true; // the toggle's own dispatch re-fires selection events; they are not the writer's
        try {
          if (base === LINK_BASE) { setup.openLink(at.block); refresh(); return; }
          try { current.toggleMark(base as TextMark); } catch (cause) { setup.report(cause); }
          refresh(); // the pressed state tells what the next click does
        } finally { acting = false; }
      });
      buttons.set(base, el);
    }
    for (const base of wanted) element.append(buttons.get(base)!); // appended in strip order
  }

  function place(host: FormatHost): void {
    // Anchor on the selection's own box, falling back to the host: above it,
    // flipping below on collision — never covering the caret's line.
    const doc = element.ownerDocument;
    let anchor = host.anchor.getBoundingClientRect();
    const selection = doc.getSelection();
    const range = selection && selection.rangeCount > 0 && host.anchor.contains(selection.anchorNode) ? selection.getRangeAt(0) : undefined;
    // Geometry is the browser's to give; DOMs without layout (the test hosts) fall back to the host's box.
    const rect = range && typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : undefined;
    if (rect && (rect.width > 0 || rect.height > 0)) anchor = rect;
    const placed = computePlacement({
      anchor: { top: anchor.top, left: anchor.left, width: anchor.width, height: anchor.height },
      floating: { width: element.offsetWidth, height: element.offsetHeight },
      viewport: { width: doc.defaultView?.innerWidth ?? 0, height: doc.defaultView?.innerHeight ?? 0 },
      side: "top",
    });
    // Viewport coordinates translated into the mount's space; position travels
    // as custom properties, so the theme owns every painted value.
    const base = element.parentElement?.getBoundingClientRect();
    element.style.setProperty("--nq-x", `${Math.round(placed.x - (base?.left ?? 0))}px`);
    element.style.setProperty("--nq-y", `${Math.round(placed.y - (base?.top ?? 0))}px`);
    element.dataset.side = placed.side;
  }

  /** Pressed states from the stored marks over the selection — the same predicate a click will toggle. */
  function refresh(): void {
    if (alignButtons !== undefined) {
      const current = String((setup.host(shown!.block)?.blockFields?.().align ?? "left"));
      for (const button of alignButtons) button.setAttribute("aria-pressed", button.dataset.align === current ? "true" : "false");
    }
    if (!shown) return;
    const host = setup.host(shown.block);
    if (!host) { hide(); return; }
    const selection = host.selection();
    if (selection.anchor !== selection.head) shownRange = { from: Math.min(selection.anchor, selection.head), to: Math.max(selection.anchor, selection.head) };
    const range = shownRange ?? { from: 0, to: 0 };
    const text = editor.view.blocks[shown.block]?.text;
    const covered = range.from < range.to && text ? text.marks.slice(range.from, range.to) : [];
    for (const [base, el] of buttons) {
      const active = base === LINK_BASE ? linkTokenOver(text?.marks ?? [], range.from, range.to) !== undefined : covered.some(names => names.some(name => baseOf(name) === base));
      el.setAttribute("aria-pressed", String(active));
    }
    place(host);
  }

  function show(id: string): void {
    const host = setup.host(id);
    if (!host) { hide(); return; }
    const linkAdmitted = setup.policyBases(id)?.includes(LINK_BASE) ?? false;
    if (!host.marks?.length && !linkAdmitted) { hide(); return; } // nothing this policy admits: no strip
    const selection = host.selection();
    if (selection.anchor === selection.head) { hide(); return; } // the policy needs a non-collapsed selection
    shownRange = { from: Math.min(selection.anchor, selection.head), to: Math.max(selection.anchor, selection.head) };
    render(host, linkAdmitted);
    shown = { block: id };
    element.hidden = false;
    refresh();
  }

  function hide(): void {
    shown = undefined;
    shownRange = undefined;
    element.hidden = true;
  }

  return {
    pointerUp(event) {
      if (event.button !== 0) return; // the policy is the primary pointer only
      const id = setup.selectionBlock();
      if (id === undefined) { hide(); return; } // a click that collapsed or moved the selection dismisses
      show(id);
    },
    reconcile() {
      if (!shown || acting) return;
      // Reconcile against the SETTLED selection: a mark change — strip click
      // or chord — re-renders the host and fires selection events mid-dispatch,
      // and those are the editor talking to itself, not the writer moving the
      // selection. One microtask later the selection is restored; anything
      // that is still not inside the host by then really did dismiss it.
      if (reconcileQueued) return;
      reconcileQueued = true;
      queueMicrotask(() => {
        reconcileQueued = false;
        if (!shown) return;
        const doc = element.ownerDocument;
        const host = setup.host(shown.block);
        if (!host) { hide(); return; } // the block's row went away
        const selection = doc.getSelection();
        const nativeInside = !!selection && selection.rangeCount > 0 && !selection.isCollapsed
          && host.anchor.contains(selection.anchorNode) && host.anchor.contains(selection.focusNode);
        // Two sources, either may tell the truth: the native selection can
        // misreport a collapsed range as live (happy-dom), and the binding
        // can hold a stale live range after the native selection left. Inside
        // means BOTH say non-collapsed and in this host.
        const binding = host.selection();
        if (!nativeInside || binding.anchor === binding.head) { hide(); return; }
        refresh();
      });
    },
    hide,
    hideFor: id => { if (shown?.block === id) hide(); },
    destroy() { hide(); buttons.clear(); element.remove(); },
  };
}
