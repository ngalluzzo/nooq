/** Explicit first-party features, implemented through the same API as third parties. */
import { applyTextChanges, liveTree, replaceChanges, type ActorKey, type Proposal } from "@nooq/core";
import { defineBlock, defineJob, definePlugin, type PublicationResult } from "@nooq/plugins";
import { defineDOMPlugin, defineTextPolicy, type BlockViewDefinition } from "@nooq/plugins/dom";
import { essentials, insertBlock, splitBlock, deleteBlock } from "@nooq/plugins/essentials";
import { blockRow, suggestionCard, tooltip, type DiffSegment, type SuggestionState } from "@nooq/design";
import { actorKindOf, type JobBinding } from "./controller.ts";
import { announce } from "./status.ts";

export { essentials } from "@nooq/plugins/essentials";
export const writingTextPolicy = defineTextPolicy({ defaultMode: "plain", enter: { command: splitBlock } });
export const essentialsDOM = defineDOMPlugin({
  id: "nooq.essentials", forPlugin: essentials,
  views: essentials.contributes.blocks.map((block, i) => ({ type: block.type, textPolicy: writingTextPolicy, mount(ctx) {
    const text = ctx.mountTextEditor({ label: block.label });
    // The bar opens this block's history. The host owns the history store and
    // the popover, so onHistory only announces the request — one bubbling
    // `nq:block-history` event, the same contract for every plugin's bars.
    const element = blockRow({
      content: [text.element, ctx.children.element],
      kind: (["paragraph", "heading", "quote"] as const)[i]!,
      actor: "human",
      onHistory: () => bar.dispatchEvent(new CustomEvent("nq:block-history", { bubbles: true })),
    });
    const bar = element.querySelector<HTMLElement>(".nq-bar")!;
    let tip: ReturnType<typeof tooltip> | undefined, tipWriter: string | undefined;
    return { element, update(block) {
      // DM-14.2: every character keeps its author; AI text stays visibly AI after adoption.
      const authors = ctx.authors(), names = authors.length ? authors.map(author => author.actorId) : [block.attribution.created.actor];
      const kinds = authors.length ? authors.map(author => author.kind) : [actorKindOf(names[0]!)];
      const actor = kinds.includes("ai") ? "ai" : kinds.every(kind => kind === "human") ? "human" : "system";
      element.dataset.actor = actor;
      bar.className = `nq-bar nq-bar-${actor === "human" ? "human" : actor === "ai" ? "ai" : "machine"} nq-bar-history`;
      // The bar is a button now: named for what it opens, explained by the
      // tooltip on hover AND focus — no title attribute to hide behind (§9).
      const writer = names[names.length - 1] ?? names[0]!;
      bar.setAttribute("aria-label", `Block history · last edited by ${writer}`);
      if (writer !== tipWriter) {
        tip?.destroy();
        tip = tooltip({ anchor: bar, text: `Last edited by ${writer}` });
        tipWriter = writer;
      }
    }, destroy: () => { tip?.destroy(); text.destroy(); } };
  } })),
  // Deleted essentials blocks stay reachable in the history layer, drawn as
  // the deleted BlockRow with Restore (DM-3.4) — the surface does the drawing.
  history: state => {
    const placed = new Set<string>();
    const visit = (ids: readonly string[]): void => { for (const id of ids) { placed.add(id); visit(state.blocks[id]?.children ?? []); } };
    visit(state.roots);
    const own = new Set(essentials.contributes.blocks.map(block => block.type));
    return Object.values(state.blocks).filter(block => own.has(block.type) && !placed.has(block.id)).map(block => block.id);
  },
  menus: essentials.contributes.blocks.map((block, i) => ({ id: `insert:${block.type}`, label: block.label, glyph: ["T", "H", "❝"][i], command: insertBlock.id,
    args(ctx) {
      const tree = liveTree(ctx.snapshot as any), parent = tree.parentOf.get(ctx.block) ?? null;
      const siblings = parent === null ? ctx.snapshot.roots : ctx.snapshot.blocks[parent]!.children;
      return { type: block.type, parent, index: siblings.indexOf(ctx.block) + 1, clearBlock: ctx.block };
    },
  })),
  keys: [
    { id: "split", key: "Enter", label: "Split block", command: splitBlock.id, args: ctx => ctx.selection },
    { id: "delete-empty", key: "Backspace", label: "Delete empty block", command: deleteBlock.id,
      when: ctx => (ctx.snapshot.blocks[ctx.block]?.text?.s ?? "") === "", args: ctx => ({ block: ctx.block }) },
  ],
});

export const review = definePlugin({ id: "nooq.review", version: "1.0.0", apiVersion: 1, contributes: { blocks: [defineBlock({
  type: "nooq.suggestion/v1", label: "Suggestion", text: "none",
  create() { throw new Error("Use the proposal publication service to create suggestions"); },
  diagnose: block => block.fields.proposal ? [] : [{ field: "proposal", message: "Suggestion has no proposal" }],
})] } });

export const reviewDOM = defineDOMPlugin({ id: "nooq.review", forPlugin: review,
  history: state => Object.values(state.blocks).filter(b => b.type === "nooq.suggestion/v1" && b.fields.status !== undefined).map(b => b.id),
  // This view keeps rendering its own tombstones in the history layer — the
  // settled card IS the history of a suggestion (DM-6.4: "kept in history").
  // `rendersHistory` is the surface's opt-in (see history-ui's viewKeepsHistory).
  views: ([{ type: "nooq.suggestion/v1", rendersHistory: true, mount(ctx) {
    const element = document.createElement("div"), content = document.createElement("div"); element.append(content, ctx.children.element);
    let sequence = 0;
    // The last status this card showed: the announcer speaks the transition, once, never per render (§9).
    let previous: SuggestionState | undefined;
    const refresh = async () => {
      const seq = ++sequence, state = ctx.snapshot(), block = state.blocks[ctx.block];
      if (!block) return;
      const proposal = block.fields.proposal as unknown as Proposal;
      const settled = block.fields.status as string | undefined;
      const reviewed = settled ? undefined : await ctx.review();
      if (seq !== sequence || ctx.signal.aborted) return;
      const status = (settled ?? reviewed?.evaluation.status ?? "conflicted") as SuggestionState;
      if (previous !== undefined && previous !== "stale" && status === "stale") announce("Suggestion is now stale.");
      previous = status;
      const context = proposal.context as { name?: string; model?: string; before?: Record<string, string> } | null;
      const diff: DiffSegment[] = [];
      for (const op of proposal.ops) {
        if (op.op === "textEdit") {
          const before = context?.before?.[op.block] ?? state.blocks[op.block]?.text?.s ?? "";
          try { if (before) diff.push({ del: before }); diff.push({ ins: applyTextChanges({ s: before, marks: Array.from({ length: before.length }, () => []) }, op.changes).s }); }
          catch { diff.push({ text: `${before} (changed since proposal)` }); }
        } else if (op.op === "setField") diff.push({ ins: `${op.key} = ${JSON.stringify(op.value)}` });
        else if (op.op === "insert") diff.push({ ins: `new ${op.block.type}` });
      }
      const settlement = block.attribution.fields.status; // who settled it, adopter included (DM-6.3)
      content.replaceChildren(suggestionCard({ state: status, actor: context?.name ?? proposal.actor, model: context?.model ?? proposal.actorDescriptor?.model,
        intent: proposal.intent, diff: diff.length ? diff : [{ text: "no visible changes" }],
        ...(["stale", "conflicted"].includes(status) ? { reason: "The document changed while this suggestion waited." } : {}),
        evidence: proposal.evidence.map(e => ({ kind: "evidence", value: e.contentDigest.slice(7, 19) })),
        ...(settlement ? { settledBy: settlement.adoptedBy ?? settlement.actor } : {}),
        onAccept: () => { if (reviewed) void ctx.accept({ force: status !== "fresh", reviewed }).catch(ctx.report).finally(() => { void refresh().catch(ctx.report); }); },
        onReject: () => { try { ctx.reject(); } catch (cause) { ctx.report(cause); } },
      }));
    };
    ctx.onChange(() => { void refresh().catch(ctx.report); });
    return { element, update() { void refresh().catch(ctx.report); }, destroy() { sequence++; } };
  } }] satisfies BlockViewDefinition[]),
});

export interface RewriteProvider {
  /** `progress` streams the text-so-far as an ephemeral preview (0008); it never reaches the document. */
  generate(input: { text: string; signal: AbortSignal; progress(value: string): void }): Promise<string>;
}
export function rewritePlugin(provider: RewriteProvider) {
  const job = defineJob<{ block: string }, PublicationResult>({ id: "nooq.ai.rewrite", label: "Improve this block", publishes: true,
    validateArgs: (input): input is { block: string } => !!input && typeof input === "object" && "block" in input && typeof input.block === "string",
    async run(ctx, args) {
      const base = ctx.capture(), [block] = base.readBlocks([args.block]), text = block!.text?.s ?? "";
      const generated = await provider.generate({ text, signal: ctx.signal, progress: ctx.progress });
      return ctx.publish(base, { ops: [{ op: "textEdit", block: args.block, changes: replaceChanges(text, generated) }], intent: "rewrite-block" });
    },
  });
  const plugin = definePlugin({ id: "nooq.ai", version: "1.0.0", apiVersion: 1, requires: { "nooq.review": "^1.0.0" }, contributes: { jobs: [job] } });
  const dom = defineDOMPlugin({ id: "nooq.ai", forPlugin: plugin, views: [], menus: [{ id: "rewrite", label: job.label, glyph: "✦", hint: "/ai", job: job.id, args: ctx => ({ block: ctx.block }) }] });
  return { plugin, job, dom };
}
/** The simulated model streams word-by-word so the working state is observable; the published result is unchanged. */
export const simulatedRewrite = rewritePlugin({
  async generate({ text, signal, progress }) {
    const target = text ? text.charAt(0).toUpperCase() + text.slice(1) : "Written by a simulated model.";
    const words = target.split(" ");
    let soFar = "";
    for (const [at, word] of words.entries()) {
      soFar = at === 0 ? word : `${soFar} ${word}`;
      progress(soFar);
      if (at === words.length - 1) break;
      if (signal.aborted) throw new DOMException("Job cancelled", "AbortError");
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    return target;
  },
});
export const referencePlugins = [essentials, review, simulatedRewrite.plugin] as const;
export const referenceDOM = [essentialsDOM, reviewDOM, simulatedRewrite.dom] as const;
export function referenceJobBindings(signer?: ActorKey): JobBinding[] {
  return [{ job: simulatedRewrite.job, actor: { actorId: "ai:reference", kind: "ai", model: "simulated/1" }, signer }];
}
