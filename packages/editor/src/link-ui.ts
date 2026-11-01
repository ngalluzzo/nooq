/**
 * The link editing flow (0009 §5): Mod-k on a selection opens the design
 * popover anchored near it, carrying one textField for the href. Enter runs
 * `nooq.text.link` over the selection — the token and its payload land in one
 * transaction (§4); an emptied href on an already-linked selection removes
 * the link. Esc closes returning focus with no change (the popover's
 * contract). Keyboard-first, off the input path: Mod-k is a chord, never a
 * typing key (§3).
 */
import { popover, textField, type PopoverHandle } from "@nooq/design";
import type { Editor } from "./controller.ts";
import { baseOf } from "./mark-tokens.ts";

/** The reserved bare base for links and the command that applies it (0009 §2/§5). */
const LINK_BASE = "link";
const LINK_COMMAND = "nooq.text.link";

/** What the link editor needs from one block's rich text binding. */
export interface LinkHost {
  /** The rich text element: the popover's anchor and where focus returns. */
  anchor: HTMLElement;
  selection(): { anchor: number; head: number };
  focus(selection?: { anchor: number; head: number }): void;
  /** The bases this binding's policy admits. */
  marks?: readonly string[];
}

export interface LinkEditorUI {
  /** A keydown from a text host. True when the chord is consumed (the popover opened). */
  keyDown(id: string, event: KeyboardEvent): boolean;
  /** Forget the popover for a block whose row is going away; silent. */
  closeFor(id: string): void;
  destroy(): void;
}

/** The link token covering the selection's first character, deterministically the smallest when two survived concurrency (0009 §1). */
export function linkTokenOver(marks: readonly (readonly string[])[], from: number, to: number): string | undefined {
  for (let at = Math.max(0, from); at < to && at < marks.length; at++) {
    const tokens = (marks[at] ?? []).filter(name => baseOf(name) === LINK_BASE).sort();
    if (tokens.length) return tokens[0];
  }
  return undefined;
}

export function createLinkUI(setup: {
  editor: Editor;
  report(cause: unknown): void;
  /** The rich text binding for a block, when one is mounted and connected. */
  host(id: string): LinkHost | undefined;
}): LinkEditorUI {
  let open: { block: string; handle: PopoverHandle } | undefined;

  const close = (): void => { open?.handle.destroy(); open = undefined; };

  function openEditor(id: string, host: LinkHost): boolean {
    const selection = host.selection();
    const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
    const block = setup.editor.view.blocks[id];
    // A chord with nothing selected, a vanished block, or an empty text has nothing to link.
    if (from === to || !block?.text || from > block.text.s.length || to > block.text.s.length) return false;
    const token = linkTokenOver(block.text.marks, from, to);
    const payload = token !== undefined ? block.fields[token] : undefined;
    close();

    const field = textField({
      label: "Link destination",
      placeholder: "https://…",
      ...(typeof payload === "string" ? { value: payload } : {}), // prefilled when the selection already carries a link
    });
    const input = field.querySelector<HTMLInputElement>("input")!;
    const body = document.createElement("div");
    body.className = "nq-link-editor";
    body.append(field);
    const handle = popover({
      anchor: host.anchor,
      side: "bottom",
      content: body,
      role: "form",
      focus: false, // the field is the focus; Esc still returns focus to the host (the popover's contract)
      onClose: () => { if (open?.handle === handle) open = undefined; },
    });
    handle.element.setAttribute("aria-label", "Edit link");
    document.body.append(handle.element);
    open = { block: id, handle };

    const apply = (): void => {
      const href = input.value.trim();
      close();
      // An emptied href removes an existing link; with no link to remove there is nothing to send.
      if (href === "" && token === undefined) { host.focus(selection); return; }
      try {
        const outcome = setup.editor.commands.run(LINK_COMMAND, { block: id, from, to, ...(href !== "" ? { href } : {}) });
        if (outcome.status === "failed") setup.report(outcome.error);
        else if (outcome.status === "denied") setup.report(new Error(outcome.reason));
      } catch (cause) { setup.report(cause); }
      host.focus(selection); // the selection the popover interrupted is the one the writer linked
    };
    body.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      apply();
    });
    input.focus();
    input.select();
    return true;
  }

  return {
    keyDown(id: string, event: KeyboardEvent): boolean {
      // The same Mod the surface's other chords use (rich-text.ts); Shift is not part of this chord.
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k") return false;
      const host = setup.host(id);
      // Only a rich text host whose policy admits links; other hosts keep the chord for their own bindings.
      if (!host || !host.marks?.includes(LINK_BASE)) return false;
      return openEditor(id, host);
    },
    closeFor(id: string): void { if (open?.block === id) close(); },
    destroy(): void { close(); },
  };
}
