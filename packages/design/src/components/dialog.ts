/**
 * The modal confirmation (foundation P2): destructive confirmations, sharing,
 * connecting a model, export — one decision a writer must make before the
 * document continues. Viewport-centered on `layer-dialog`, labelled by its
 * title, `aria-modal`. Tab and Shift+Tab stay inside; focus opens on the
 * first non-destructive action; Escape or a press outside cancels, which is
 * `onClose` and never a destructive action. Activating an action runs its
 * handler and closes the dialog — an action is a decision, not a cancel, so
 * it does not report through `onClose`. On any close, focus returns to the
 * opener.
 *
 * Usage: append `element` (in the same tick) wherever overlays mount, and keep
 * `destroy()` for programmatic teardown (silent, focus still returns). The
 * consumer provides the title, the body, the actions (verbs; the primary
 * renders rightmost, a destructive action is the danger variant) and the
 * cancel handler. Not for anchored, non-modal surfaces — that is the popover —
 * and not for inline status a writer reads while working — that is the notice.
 * A dialog is not anchored, so it shares the popover's focus discipline, not
 * its placement math or its stack.
 *
 * v1 has no backdrop: no scrim token exists yet. The dialog floats over a
 * still-legible page on `layer-dialog`, above every popover, and a press
 * outside stands in for a backdrop click by cancelling.
 */
import { el, type Child } from "../dom.ts";
import { button, type ButtonProps } from "./button.ts";

/** How the writer cancelled. Activating an action is not a cancel; `destroy()` is programmatic and reports nothing. */
export type DialogCloseReason = "escape" | "outside";

export interface DialogAction {
  /** A short verb naming the outcome: "Delete document", "Keep mine". */
  label: Child;
  /** The button's variant. danger: a destructive confirmation (stamp); primary: the one action a writer most likely wants — rendered rightmost. */
  variant?: ButtonProps["variant"];
  /** Runs when the writer activates the action; the dialog then closes itself. */
  onClick?: () => void;
}

export interface DialogOptions {
  /** One line naming what is being decided. */
  title: Child;
  /** The explanation: any DOM or text. */
  body: Child;
  /** The writer's choices, rendered right-aligned; the primary action is moved rightmost. */
  actions: readonly DialogAction[];
  /** Called when the writer cancels with Escape or a press outside the dialog. */
  onClose?: (reason: DialogCloseReason) => void;
}

export interface DialogHandle {
  element: HTMLElement;
  /** Remove the dialog and its listeners. Silent: `onClose` is not called. */
  destroy(): void;
}

/** Elements inside the dialog that Tab can reach, in visual order. */
const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/** Open dialogs, innermost last, so Escape cancels one at a time. Popovers keep their own stack; layer-dialog sits above them. */
const stack: Array<(reason: DialogCloseReason) => void> = [];

let dialogCount = 0;

export function dialog({ title, body, actions, onClose }: DialogOptions): DialogHandle {
  const controller = new AbortController();
  const signal = { signal: controller.signal };
  const titleId = `nq-dialog-title-${++dialogCount}`;
  // A dialog has no anchor; the opener is whatever had focus when it opened,
  // and focus returns there on close.
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const buttons = actions.map((action) => ({
    action,
    node: button({
      label: action.label,
      variant: action.variant,
      onClick: () => {
        action.onClick?.();
        // A decision, not a cancel: teardown is silent.
        close();
      },
    }),
  }));
  // Actions right-align with the primary rightmost, in Tab order to match.
  const ordered = buttons
    .filter(({ action }) => action.variant !== "primary")
    .concat(buttons.filter(({ action }) => action.variant === "primary"));

  const element = el(
    "div",
    {
      class: "nq-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      tabindex: "-1",
    },
    el("div", { class: "nq-dialog-title nq-ui-heading", id: titleId }, title),
    el("div", { class: "nq-dialog-body nq-ui-body" }, body),
    el("footer", { class: "nq-dialog-actions" }, ordered.map(({ node }) => node)),
  );

  // Focus opens on the first non-destructive action, so Enter alone never destroys anything.
  const focusTarget = ordered.find(({ action }) => action.variant !== "danger")?.node ?? element;

  function focusable(): HTMLElement[] {
    return Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => node.isConnected);
  }

  let closed = false;

  function close(reason?: DialogCloseReason): void {
    if (closed) return;
    closed = true;
    const index = stack.indexOf(close);
    if (index >= 0) stack.splice(index, 1);
    // Return focus only when it would otherwise be stranded inside the closed dialog.
    if (element.contains(document.activeElement) && opener?.isConnected) opener.focus();
    controller.abort();
    element.remove();
    if (reason) onClose?.(reason);
  }
  stack.push(close);

  element.addEventListener(
    "keydown",
    (event) => {
      if ((event as KeyboardEvent).key !== "Tab") return;
      const inside = focusable();
      const first = inside[0];
      const last = inside[inside.length - 1];
      const active = document.activeElement;
      const wrapTo = (node: HTMLElement | undefined): void => {
        event.preventDefault();
        (node ?? element).focus();
      };
      if (event.shiftKey && (active === first || active === element || first === undefined)) wrapTo(last);
      else if (!event.shiftKey && (active === last || active === element || last === undefined)) wrapTo(first);
    },
    signal,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if ((event as KeyboardEvent).key !== "Escape" || stack[stack.length - 1] !== close) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close("escape");
    },
    { ...signal, capture: true },
  );
  // With no backdrop to press, a press anywhere outside the dialog is the cancel.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (!(target instanceof Node) || element.contains(target)) return;
      close("outside");
    },
    { ...signal, capture: true },
  );

  // Move in once — the microtask normally lands before the first paint; the
  // rAF only covers a caller that appends later. Re-focusing on every hook
  // would fight a writer who already Tabbed inside.
  let movedIn = false;
  const moveIn = (): void => {
    if (movedIn || closed || !element.isConnected) return;
    movedIn = true;
    focusTarget.focus();
  };
  queueMicrotask(moveIn);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(moveIn);

  return { element, destroy: () => close() };
}
