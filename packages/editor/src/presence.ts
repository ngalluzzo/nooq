/**
 * Remote presence (SW-7), painted without writing into text. Selections are
 * CSS Custom Highlights over ranges in the text hosts; carets and name flags
 * sit in an overlay above them. Text hosts belong to plugins and the editing
 * engine, so presence never edits their DOM and cannot disturb the local
 * caret, composition or input path (§3, EB-6).
 */
import { caretAfterChanges, replaceChanges, type DocState } from "@nooq/core";
import { resolveTextRange, type TextRangeSegment } from "@nooq/plugins";
import { peerInk, presenceCaret, type PeerInk } from "@nooq/design";
import type { AwarenessEntry } from "@nooq/sync";

interface Point { block: string; offset: number }
/** A peer's cursor as this surface holds it: its points, and the text each was last mapped against (undefined: still ahead of us). */
interface Held { received: AwarenessEntry["cursor"]; points: Point[]; texts: (string | undefined)[] }
interface Placed { actor: string; name: string; caret: Point; anchor?: Point }
/** The setlike surface of Highlight and HighlightRegistry; lib.dom types it only with DOM.Iterable. */
interface RangeSet { add(range: AbstractRange): unknown; delete(range: AbstractRange): boolean; readonly size: number }
interface Registry { get(name: string): RangeSet | undefined; set(name: string, highlight: RangeSet): unknown; delete(name: string): boolean }

export interface Presence {
  /** Call after every render: remote cursors map through the edit now; painting waits for the next frame. */
  update(state: DocState, peers: readonly AwarenessEntry[]): void;
  destroy(): void;
}

/** Highlight names are document-global: surfaces on one page share a highlight per ink, each adding only its own ranges. */
const highlightName = (ink: PeerInk) => `nq-peer-${ink}`;
const isPoint = (value: unknown): value is Point =>
  typeof value === "object" && value !== null && typeof (value as Point).block === "string" && Number.isInteger((value as Point).offset) && (value as Point).offset >= 0;

export function createPresence(root: HTMLElement, hosts: () => ReadonlyMap<string, HTMLElement>): Presence {
  const globals = globalThis as unknown as { CSS?: { highlights?: Registry }; Highlight?: new () => RangeSet };
  const registry = globals.CSS?.highlights, HighlightClass = globals.Highlight;
  const layer = document.createElement("div");
  layer.className = "nq-presence"; layer.setAttribute("aria-hidden", "true");
  root.append(layer);
  const inks = new Map<string, PeerInk>(), resolving = new Set<string>(), owned = new Map<PeerInk, AbstractRange[]>(), held = new Map<string, Held>();
  let frame = 0, destroyed = false, latest: { state: DocState; peers: Placed[] } | undefined;

  /**
   * Offsets arrive against the sender's text. Edits after that — ours or a
   * third writer's — would slide them onto other characters until the sender
   * speaks again, so each point maps through every change since it arrived:
   * the local caret's EB-7 math. A point past our text's end is ahead of us
   * (its update is still verifying) and waits, unmapped, until that text lands.
   */
  function hold(state: DocState, peer: AwarenessEntry): Placed | undefined {
    const cursor = peer.cursor;
    if (!isPoint(cursor)) { held.delete(peer.actor); return; }
    let entry = held.get(peer.actor);
    if (entry?.received !== cursor) {
      const points = isPoint(cursor.anchor) ? [cursor, cursor.anchor] : [cursor];
      entry = { received: cursor, points: points.map(p => ({ block: p.block, offset: p.offset })), texts: points.map(() => undefined) };
      held.set(peer.actor, entry);
    }
    entry.points.forEach((point, i) => {
      const text = state.blocks[point.block]?.text?.s, before = entry.texts[i];
      if (text === undefined || before === text) return;
      if (before !== undefined) point.offset = caretAfterChanges(replaceChanges(before, text), point.offset);
      if (before !== undefined || point.offset <= text.length) entry.texts[i] = text;
    });
    const [caret, anchor] = entry.points;
    return { actor: peer.actor, name: peer.name ?? peer.actor, caret: caret!, ...(anchor ? { anchor } : {}) };
  }

  /** Inks hash the actor ID on WebCrypto: a peer appears once its ink resolves, never in a borrowed color. */
  function inkOf(actor: string): PeerInk | undefined {
    const ink = inks.get(actor);
    if (!ink && !resolving.has(actor)) {
      resolving.add(actor);
      void peerInk(actor).then(resolved => { inks.set(actor, resolved); resolving.delete(actor); if (latest) schedule(); });
    }
    return ink;
  }
  /** A block offset as a DOM boundary in its host; past the end clamps (the peer may hold text we do not yet). */
  function boundary(host: HTMLElement, offset: number): [Node, number] {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, offset), node = walker.nextNode(), last: Node | null = null;
    while (node) { const length = node.textContent!.length; if (remaining <= length) return [node, remaining]; remaining -= length; last = node; node = walker.nextNode(); }
    return last ? [last, last.textContent!.length] : [host, host.childNodes.length];
  }
  /** Rebuilt every paint, so a static range: live ranges would tax every DOM mutation on the page. */
  function rangeOf(start: [Node, number], end: [Node, number]): AbstractRange {
    if (typeof StaticRange === "function") return new StaticRange({ startContainer: start[0], startOffset: start[1], endContainer: end[0], endOffset: end[1] });
    const range = document.createRange(); range.setStart(...start); range.setEnd(...end); return range;
  }
  /** The caret's line box in viewport coordinates. A collapsed range has none at a line end or in an empty host. */
  function caretBox(host: HTMLElement, [node, offset]: [Node, number]): { left: number; top: number; height: number } {
    const range = document.createRange(); range.setStart(node, offset);
    const rect = range.getClientRects()[0];
    if (rect && rect.height > 0) return { left: rect.left, top: rect.top, height: rect.height };
    const length = node.nodeType === Node.TEXT_NODE ? node.textContent!.length : 0;
    if (offset > 0 && length) {
      range.setStart(node, offset - 1); range.setEnd(node, offset);
      const rects = range.getClientRects(), before = rects[rects.length - 1];
      if (before && before.height > 0) return { left: before.right, top: before.top, height: before.height };
    }
    if (offset < length) {
      range.setStart(node, offset); range.setEnd(node, offset + 1);
      const after = range.getClientRects()[0];
      if (after && after.height > 0) return { left: after.left, top: after.top, height: after.height };
    }
    const box = host.getBoundingClientRect(), line = parseFloat(getComputedStyle(host).lineHeight);
    return { left: box.left, top: box.top, height: Number.isFinite(line) ? line : box.height };
  }
  function segments(state: DocState, caret: Point, anchor: Point): TextRangeSegment[] {
    const clamp = (point: Point): Point => ({ block: point.block, offset: Math.min(point.offset, state.blocks[point.block]?.text?.s.length ?? 0) });
    const a = clamp(anchor), h = clamp(caret);
    if (a.block === h.block) return a.offset === h.offset ? [] : [{ block: a.block, from: Math.min(a.offset, h.offset), to: Math.max(a.offset, h.offset) }];
    return resolveTextRange(state, { anchor: a, head: h })?.filter(s => s.from < s.to) ?? [];
  }
  function clearHighlights() {
    for (const [ink, ranges] of owned) {
      const highlight = registry?.get(highlightName(ink));
      if (!highlight) continue;
      for (const range of ranges) highlight.delete(range);
      if (highlight.size === 0) registry!.delete(highlightName(ink));
    }
    owned.clear();
  }
  function highlight(ink: PeerInk, ranges: AbstractRange[]) {
    const name = highlightName(ink);
    let target = registry!.get(name);
    if (!target) { target = new HighlightClass!(); registry!.set(name, target); }
    for (const range of ranges) target.add(range);
    owned.set(ink, [...owned.get(ink) ?? [], ...ranges]);
  }
  function paint() {
    frame = 0;
    if (destroyed || !latest) return;
    const { state, peers } = latest, entries = hosts(), carets: HTMLElement[] = [];
    let origin: DOMRect | undefined;
    clearHighlights();
    for (const { actor, name, caret, anchor } of peers) {
      const host = entries.get(caret.block), ink = host && inkOf(actor);
      if (!host || !ink) continue;
      if (registry && HighlightClass && anchor) {
        const ranges = segments(state, caret, anchor).flatMap(({ block, from, to }) => {
          const at = entries.get(block);
          return at ? [rangeOf(boundary(at, from), boundary(at, to))] : [];
        });
        if (ranges.length) highlight(ink, ranges);
      }
      const box = caretBox(host, boundary(host, Math.min(caret.offset, state.blocks[caret.block]?.text?.s.length ?? 0)));
      origin ??= layer.getBoundingClientRect();
      const wrapper = document.createElement("div");
      wrapper.className = "nq-presence-peer"; wrapper.dataset.nqActor = actor;
      wrapper.style.cssText = `left:${box.left - origin.left}px;top:${box.top - origin.top}px;height:${box.height}px`;
      wrapper.append(presenceCaret({ name, ink }));
      carets.push(wrapper);
    }
    layer.replaceChildren(...carets);
  }
  function schedule() { if (!frame && !destroyed) frame = requestAnimationFrame(paint); }
  // Reflow moves text under the carets without a render: follow the surface's size.
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (latest) schedule(); }) : undefined;
  resize?.observe(root);

  return {
    update(state, peers) {
      for (const actor of held.keys()) if (!peers.some(peer => peer.actor === actor)) held.delete(actor);
      const placed = peers.flatMap(peer => hold(state, peer) ?? []);
      // Nothing to show and nothing shown: no frame, no layout read — a lone writer pays nothing.
      if (!placed.length && !layer.childElementCount && !owned.size) { latest = undefined; return; }
      latest = { state, peers: placed }; schedule();
    },
    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect(); clearHighlights(); layer.remove();
    },
  };
}
