/**
 * Client registry — DM-14.2 in the adapter.
 *
 * Every Yjs client ID is registered, once, to the actor whose items it
 * writes. A document instance keeps one client per attribution (actor, kind,
 * model, adopter), so the human, an AI and each adoption write through
 * different clients and every character's author is its item's client.
 */

import * as Y from "yjs";
import { canonicalJson, type BlockId, type ClientRegistration } from "@nooq/core";
import { layout } from "./layout.ts";

/** Clients this document instance writes, by attribution. Never reused across instances. */
const owned = new WeakMap<Y.Doc, Map<string, number>>();

/** Switch the document to this attribution's client: one it already writes, else its virgin client, else a fresh one. */
export function useClientFor(doc: Y.Doc, registration: ClientRegistration): void {
  const key = canonicalJson(registration);
  let mine = owned.get(doc);
  if (!mine) owned.set(doc, (mine = new Map()));
  let client = mine.get(key);
  if (client === undefined) {
    const taken = new Set(mine.values());
    client = isFree(doc, doc.clientID) && !taken.has(doc.clientID) ? doc.clientID : freshClient(doc, taken);
    mine.set(key, client);
  }
  doc.clientID = client;
}

function isFree(doc: Y.Doc, client: number): boolean {
  return !layout(doc).clients.has(String(client)) && !doc.store.clients.has(client);
}

function freshClient(doc: Y.Doc, taken: Set<number>): number {
  for (;;) {
    const candidate = crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (isFree(doc, candidate) && !taken.has(candidate)) return candidate;
  }
}

/** The registry as a plain map: client ID → registration. */
export function clientRegistry(doc: Y.Doc): Map<number, ClientRegistration> {
  const out = new Map<number, ClientRegistration>();
  for (const [client, registration] of layout(doc).clients.entries()) out.set(Number(client), structuredClone(registration));
  return out;
}

export interface AuthorRun {
  /** Characters (UTF-16 code units) in this run. */
  length: number;
  /** Undefined for items written before registration existed, or by an unregistered client. */
  author: ClientRegistration | undefined;
}

/** DM-14.2: who wrote each character of a block's text, as runs in text order. Computed on demand. */
export function textAuthors(doc: Y.Doc, blockId: BlockId): AuthorRun[] {
  const text = layout(doc).blocks.get(blockId)?.get("text");
  if (!(text instanceof Y.Text)) return [];
  const registry = layout(doc).clients;
  const runs: Array<{ length: number; client: number }> = [];
  for (let item = text._start; item !== null; item = item.right) {
    if (item.deleted || !item.countable) continue;
    const last = runs[runs.length - 1];
    if (last && last.client === item.id.client) last.length += item.length;
    else runs.push({ length: item.length, client: item.id.client });
  }
  return runs.map(({ length, client }) => {
    const author = registry.get(String(client));
    return { length, author: author === undefined ? undefined : structuredClone(author) };
  });
}
