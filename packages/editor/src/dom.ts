/**
 * DOM surface — the visible half of the reference editor.
 *
 * Built entirely from @nooq/design components and Editor's public API.
 * Every keystroke is a transaction (§1); the surface re-renders from the
 * projection on change (boring v1 — incremental rendering is a later
 * optimization, never an architectural secret).
 *
 * Text editing uses a textarea per focused block with whole-block
 * replacement (v0 textEdit semantics, DM-4.3). This is the seam where
 * the ProseMirror binding lands (DM-9): same transactions, better caret.
 */

import { liveTree, type BlockId, type DocState, type Op, type Proposal } from "@nooq/core";
import {
  blockRow,
  peerInk,
  presenceCaret,
  slashMenu,
  suggestionCard,
  syncStatus,
  type DiffSegment,
  type SlashMenuItem,
  type SuggestionState,
} from "@nooq/design";
import { actorKindOf, aliveInOrder, parentOf, type Editor } from "./controller.ts";

const TEXT_KINDS: Record<string, "paragraph" | "heading" | "quote"> = {
  "nooq.paragraph/v1": "paragraph",
  "nooq.heading/v1": "heading",
  "nooq.quote/v1": "quote",
};

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
  let caretPosition = 0;
  let renderSeq = 0;
  let destroyed = false;
  let menu: { block: BlockId; element: HTMLElement } | null = null;
  /** Derived suggestion states (DM-6.5): recomputed every render, never stored. */
  let suggestionStatus = new Map<BlockId, SuggestionState>();
  /** Peer inks are derived (async sha256), so resolve them per render pass. */
  let peerInks = new Map<string, import("@nooq/design").PeerInk>();

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
        await Promise.all(
          [...editor.awareness.keys()].map(async (actor) => [actor, await peerInk(actor)] as const),
        ),
      );
      if (destroyed || seq !== renderSeq) return;
      render(view);
    });
  }

  function render(view: DocState): void {
    body.replaceChildren();
    settledArea.replaceChildren();
    status.replaceChildren(
      syncStatus({
        state: editor.hasTransport ? (editor.synced ? "synced" : "syncing") : "local",
        count: editor.awareness.size,
      }),
    );
    for (const id of view.roots) renderBlock(view, id, body);
    const alive = liveTree(view).alive;
    for (const block of Object.values(view.blocks)) {
      if (block.type === "nooq.suggestion/v1" && !alive.has(block.id)) {
        settledArea.append(renderSuggestionCard(view, block.id, block.fields.status as string | undefined));
      }
    }
    applyFocus(view);
  }

  function renderBlock(view: DocState, id: BlockId, into: HTMLElement): void {
    const block = view.blocks[id];
    if (!block) return;
    if (block.type === "nooq.suggestion/v1") {
      into.append(renderSuggestionCard(view, id, undefined));
      return;
    }
    const kind = TEXT_KINDS[block.type];
    if (!kind) {
      const group = document.createElement("div");
      group.className = "nq-group";
      for (const child of block.children) renderBlock(view, child, group);
      into.append(group);
      return;
    }
    into.append(renderTextRow(view, id, kind));
  }

  function renderTextRow(view: DocState, id: BlockId, kind: "paragraph" | "heading" | "quote"): HTMLElement {
    const block = view.blocks[id]!;
    const writer = block.attribution.text?.actor ?? block.attribution.created.actor;
    // v1: every text block is always a textarea (whole-block replace, DM-4.3).
    // Remote presence renders as a caret chip at the row's leading edge;
    // inline-offset carets arrive with the ProseMirror binding (DM-9).
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
      caretPosition = area.selectionStart ?? area.value.length;
      if (area.value === "/") openMenu(id);
      else if (menu?.block === id) closeMenu();
      editor.editText(id, area.value);
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
      ops: [{ op: "textEdit", block, replace: { s: rewritten, marks: rewritten.split("").map(() => []) } }],
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
    const card = suggestionCard({
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
    return card;
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
        const before = view.blocks[op.block]?.text?.s;
        if (before) segments.push({ del: before });
        segments.push({ ins: op.replace.s });
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
