/**
 * DOM surface — the visible half of the reference editor.
 *
 * Built entirely from @nooq/design components and Editor's public API.
 * Every keystroke is a transaction (§1). Rendering is INCREMENTAL: each
 * block owns a row element that is reused unless the block's rendered
 * inputs changed — an untouched textarea is never recreated, so the
 * caret and selection survive by construction (EB-6, EB-7). A remote
 * text edit updates the focused textarea's value in place and moves
 * the selection with DM-4.3 splice math: the caret stays on the same
 * characters (EB-7.1); a delete covering it collapses it to the splice
 * point, never beyond.
 */

import {
  applyTextChanges,
  caretAfterChanges,
  liveTree,
  replaceChanges,
  type BlockId,
  type DocState,
  type Op,
  type Proposal,
} from "@nooq/core";
import {
  blockRow,
  peerInk,
  presenceCaret,
  slashMenu,
  suggestionCard,
  syncStatus,
  type DiffSegment,
  type PeerInk,
  type SlashMenuItem,
  type SuggestionState,
} from "@nooq/design";
import { actorKindOf, aliveInOrder, parentOf, type Editor } from "./controller.ts";

const TEXT_KINDS: Record<string, "paragraph" | "heading" | "quote"> = {
  "nooq.paragraph/v1": "paragraph",
  "nooq.heading/v1": "heading",
  "nooq.quote/v1": "quote",
};

interface RowRecord {
  row: HTMLElement;
  /** Signature of the row's structure (type, writer, presence): text-only changes take the in-place path. */
  structure: string;
  signature: string;
  value: string; // last text value rendered into the textarea
}

export interface EditorSurface {
  element: HTMLElement;
  destroy(): void;
}

export function createSurface(editor: Editor): EditorSurface {
  const root = document.createElement("div");
  root.className = "nq-editor";
  const status = document.createElement("div");
  const body = document.createElement("div");
  const settledArea = document.createElement("div");
  root.append(status, body, settledArea);

  let focused: BlockId | null = null;
  let focusRequest: { block: BlockId; offset?: number } | null = null;
  let renderSeq = 0;
  let destroyed = false;
  let menu: { block: BlockId; element: HTMLElement } | null = null;
  /** Derived suggestion states (DM-6.5): recomputed every render, never stored. */
  let suggestionStatus = new Map<BlockId, SuggestionState>();
  /** Peer inks are derived (async sha256), so resolve them per render pass. */
  let peerInks = new Map<string, PeerInk>();
  /** Live rows by block id — reused across renders (incremental rendering). */
  const rows = new Map<BlockId, RowRecord>();
  let lastOrder: BlockId[] = [];

  const unsubscribe = editor.onChange(scheduleRender);
  scheduleRender();

  function scheduleRender(): void {
    const seq = ++renderSeq;
    queueMicrotask(async () => {
      if (destroyed || seq !== renderSeq) return;
      const view = editor.view;
      suggestionStatus = new Map(
        await Promise.all(
          Object.values(view.blocks)
            .filter((block) => block.type === "nooq.suggestion/v1")
            .map(async (block) => [block.id, (await editor.evaluate(block.id)).status] as const),
        ),
      );
      if (destroyed || seq !== renderSeq) return;
      peerInks = new Map(
        await Promise.all([...editor.awareness.keys()].map(async (actor) => [actor, await peerInk(actor)] as const)),
      );
      if (destroyed || seq !== renderSeq) return;
      render(view);
    });
  }

  function render(view: DocState): void {
    status.replaceChildren(
      syncStatus({
        state: editor.hasTransport ? (editor.synced ? "synced" : "syncing") : "local",
        count: editor.awareness.size,
      }),
    );

    // Desired order of renderable blocks: text rows and suggestion cards,
    // depth-first (§7: every block equal, built-in or not).
    const order: BlockId[] = [];
    const walk = (ids: readonly BlockId[]): void => {
      for (const id of ids) {
        const block = view.blocks[id];
        if (!block) continue;
        if (block.type === "nooq.suggestion/v1" || TEXT_KINDS[block.type]) order.push(id);
        walk(block.children);
      }
    };
    walk(view.roots);

    const seen = new Set<BlockId>();
    for (const id of order) {
      seen.add(id);
      renderOne(view, id);
    }
    for (const id of [...rows.keys()]) {
      if (!seen.has(id)) {
        rows.get(id)!.row.remove();
        rows.delete(id);
      }
    }

    // Reorder only when the order actually changed. Rows are reused, but
    // moving a focused node can blur it — restore focus and selection after.
    const orderChanged = order.length !== lastOrder.length || order.some((id, i) => lastOrder[i] !== id);
    if (orderChanged) {
      const active = document.activeElement as HTMLElement | null;
      const selection =
        active instanceof HTMLTextAreaElement
          ? ([active.selectionStart, active.selectionEnd] as const)
          : null;
      for (const id of order) body.append(rows.get(id)!.row);
      if (active && root.contains(active)) {
        active.focus();
        if (active instanceof HTMLTextAreaElement && selection) {
          active.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
        }
      }
      lastOrder = order;
    }

    // Settled suggestions (tombstoned with a verdict) render in the history area.
    settledArea.replaceChildren();
    const alive = liveTree(view).alive;
    for (const block of Object.values(view.blocks)) {
      if (block.type === "nooq.suggestion/v1" && !alive.has(block.id)) {
        settledArea.append(renderSuggestionCard(view, block.id, block.fields.status as string | undefined));
      }
    }
    applyFocus(view);
  }

  function renderOne(view: DocState, id: BlockId): void {
    const block = view.blocks[id];
    if (!block) return;
    if (block.type === "nooq.suggestion/v1") {
      const record = rows.get(id);
      const signature = JSON.stringify([suggestionStatus.get(id) ?? "fresh", editor.settledBy(id)]);
      if (record && record.signature === signature) return;
      const card = renderSuggestionCard(view, id, undefined);
      if (record) record.row.replaceWith(card);
      rows.set(id, { row: card, structure: signature, signature, value: "" });
      return;
    }
    const kind = TEXT_KINDS[block.type]!;
    const text = block.text?.s ?? "";
    const marks = block.text?.marks ?? [];
    const writer = block.attribution.text?.actor ?? block.attribution.created.actor;
    const remote = [...editor.awareness.values()].filter((entry) => entry.cursor?.block === id);
    const structure = JSON.stringify([block.type, writer, remote.map((e) => [e.actor, e.cursor?.offset])]);
    const signature = JSON.stringify([structure, text, marks]);

    const record = rows.get(id);
    if (record && record.signature === signature) return; // untouched: caret survives by construction

    if (record && record.structure === structure) {
      const area = record.row.querySelector("textarea");
      if (area) {
        if (area.value !== text) {
          const splice = replaceChanges(record.value, text);
          if (document.activeElement === area) {
            // Caret preservation is splice math, not a guess (EB-7.1).
            const start = caretAfterChanges(splice, area.selectionStart ?? area.value.length);
            const end = caretAfterChanges(splice, area.selectionEnd ?? area.value.length);
            area.value = text;
            area.setSelectionRange(start, end);
          } else {
            area.value = text;
          }
        }
        record.value = text;
        record.signature = signature;
        return;
      }
    }

    const row = renderTextRow(view, id, kind);
    if (record) record.row.replaceWith(row);
    rows.set(id, { row, structure, signature, value: text });
  }

  function renderTextRow(view: DocState, id: BlockId, kind: "paragraph" | "heading" | "quote"): HTMLElement {
    const block = view.blocks[id]!;
    const writer = block.attribution.text?.actor ?? block.attribution.created.actor;
    const content: (Node | string)[] = [];
    const remote = [...editor.awareness.values()].filter((entry) => entry.cursor?.block === id);
    if (remote.length > 0) {
      const first = remote[0]!;
      content.push(presenceCaret({ name: first.name ?? first.actor, ink: peerInks.get(first.actor) ?? "slate" }));
    }
    content.push(textareaFor(id, block.text?.s ?? ""));
    const row = blockRow({ content, kind, actor: actorKindOf(writer), writer, deleted: false });
    row.dataset.nqBlock = id;
    row.addEventListener("focusin", () => (focused = id));
    return row;
  }

  function textareaFor(id: BlockId, value: string): HTMLTextAreaElement {
    const area = document.createElement("textarea");
    area.className = "nq-input";
    area.value = value;
    area.setAttribute("aria-label", "Text block");
    area.addEventListener("input", () => {
      if (area.value === "/") openMenu(id);
      else if (menu?.block === id) closeMenu();
      editor.editText(id, area.value); // diffs to a minimal splice (DM-4.3)
    });
    area.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        editor.editText(id, area.value);
        const view = editor.view;
        const parent = parentOf(view, id) ?? null;
        const siblings = parent === null ? view.roots : view.blocks[parent]?.children ?? [];
        const created = editor.insertBlock({ type: "nooq.paragraph/v1", parent, index: siblings.indexOf(id) + 1 });
        focusRequest = { block: created, offset: 0 };
      } else if (event.key === "Backspace" && area.value === "") {
        event.preventDefault();
        const order = aliveInOrder(editor.view);
        const previous = order[order.indexOf(id) - 1];
        editor.deleteBlock(id);
        if (previous) focusRequest = { block: previous, offset: Number.MAX_SAFE_INTEGER };
      } else if (event.key === "Escape") {
        closeMenu();
      }
    });
    return area;
  }

  const MENU_ITEMS: SlashMenuItem[] = [
    { label: "Text", type: "nooq.paragraph/v1", glyph: "T", hint: "plain" },
    { label: "Heading", type: "nooq.heading/v1", glyph: "H", hint: "##" },
    { label: "Quote", type: "nooq.quote/v1", glyph: "❝", hint: ">" },
    { label: "Improve this block", type: "nooq.ai.rewrite/v1", glyph: "✦", hint: "/ai", ai: true },
  ];

  function openMenu(block: BlockId): void {
    closeMenu();
    const element = slashMenu({
      items: MENU_ITEMS,
      onSelect: (item) => {
        closeMenu();
        editor.editText(block, "");
        if (item.ai) {
          void aiRewrite(block);
          return;
        }
        const view = editor.view;
        const parent = parentOf(view, block) ?? null;
        const siblings = parent === null ? view.roots : view.blocks[parent]?.children ?? [];
        const created = editor.insertBlock({ type: item.type, parent, index: siblings.indexOf(block) + 1 });
        focusRequest = { block: created, offset: 0 };
      },
      onClose: closeMenu,
    });
    root.append(element); // outside `body`: re-renders must not destroy an open menu
    menu = { block, element };
  }

  function closeMenu(): void {
    if (menu) {
      menu.element.remove();
      menu = null;
    }
  }

  /**
   * A simulated model plugin, clearly labeled: it proposes an uppercase
   * rewrite through the same public propose() a real model plugin calls.
   * Swap in a real provider; nothing else changes.
   */
  async function aiRewrite(block: BlockId): Promise<void> {
    const text = editor.view.blocks[block]?.text?.s ?? "";
    const rewritten = text === "" ? "Written by a simulated model." : text.charAt(0).toUpperCase() + text.slice(1);
    await editor.propose({
      ops: [{ op: "textEdit", block, changes: replaceChanges(text, rewritten) }],
      evidence: [block, ...ancestorsOf(editor.view, block)],
      actor: { actorId: "ai:reference", name: "Reference assistant", model: "simulated/1" },
      intent: "rewrite-block",
    });
  }

  function ancestorsOf(view: DocState, block: BlockId): BlockId[] {
    const tree = liveTree(view);
    const out: BlockId[] = [];
    let current = tree.parentOf.get(block);
    while (current) {
      out.push(current);
      current = tree.parentOf.get(current);
    }
    return out;
  }

  function renderSuggestionCard(view: DocState, id: BlockId, settled: string | undefined): HTMLElement {
    const block = view.blocks[id]!;
    const proposal = block.fields.proposal as unknown as Proposal;
    const state = (settled ?? suggestionStatus.get(id) ?? "fresh") as SuggestionState;
    const intent = intentFor(view, id);
    return suggestionCard({
      state,
      actor: (proposal.context as { name?: string } | null)?.name ?? proposal.actor,
      model: (proposal.context as { model?: string } | null)?.model,
      ...(intent ? { intent } : {}),
      diff: diffFor(view, proposal),
      ...(state === "stale" || state === "conflicted" ? { reason: "The block changed while this suggestion waited (DM-6.5)." } : {}),
      evidence: proposal.evidence.map((entry) => ({ kind: "evidence", value: entry.contentDigest.slice(7, 19) })),
      ...(settled ? { settledBy: editor.settledBy(id) } : {}),
      onAccept: () => {
        void editor
          .accept(id, { force: state !== "fresh" })
          .catch(() => undefined) // a forced accept may fail loudly (DM-6.3)
          .finally(scheduleRender);
      },
      onReject: () => {
        editor.reject(id);
      },
    });
  }

  /** DM-4 durable intent: the proposing transaction's intent, shown as written. */
  function intentFor(view: DocState, id: BlockId): string | undefined {
    for (let i = view.log.length - 1; i >= 0; i--) {
      const tx = view.log[i]!;
      if (tx.ops.some((op) => op.op === "insert" && op.block.id === id)) return tx.intent;
    }
    return undefined;
  }

  function diffFor(view: DocState, proposal: Proposal): DiffSegment[] {
    const segments: DiffSegment[] = [];
    for (const op of proposal.ops as Op[]) {
      if (op.op === "textEdit") {
        const before = (proposal.context as { before?: Record<string, string> } | null)?.before?.[op.block]
          ?? view.blocks[op.block]?.text?.s ?? "";
        try {
          const after = applyTextChanges({ s: before, marks: [] }, op.changes).s;
          if (before) segments.push({ del: before });
          segments.push({ ins: after });
        } catch {
          segments.push({ text: `${before} (changed since proposal)` });
        }
      } else if (op.op === "setField") {
        segments.push({ ins: `${op.key} = ${JSON.stringify(op.value)}` });
      } else if (op.op === "insert") {
        segments.push({ ins: `new ${op.block.type}` });
      }
    }
    return segments.length > 0 ? segments : [{ text: "no visible changes" }];
  }

  function applyFocus(view: DocState): void {
    const request = focusRequest;
    focusRequest = null;
    if (!request || !liveTree(view).alive.has(request.block)) return;
    focused = request.block;
    const area = body.querySelector<HTMLTextAreaElement>(`[data-nq-block="${request.block}"] textarea`);
    area?.focus();
    if (area) {
      const at = Math.min(request.offset ?? area.value.length, area.value.length);
      area.setSelectionRange(at, at);
    }
  }

  return {
    element: root,
    destroy() {
      destroyed = true;
      unsubscribe();
      closeMenu();
      root.remove();
    },
  };
}
