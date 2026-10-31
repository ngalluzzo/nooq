/** Explicit first-party features, implemented through the same API as third parties. */
import { applyTextChanges, liveTree, replaceChanges, type ActorKey, type Proposal } from "@nooq/core";
import { defineBlock, defineJob, definePlugin, type PublicationResult } from "@nooq/plugins";
import { defineDOMPlugin } from "@nooq/plugins/dom";
import { essentials, insertBlock, splitBlock, deleteBlock } from "@nooq/plugins/essentials";
import { blockRow, suggestionCard, type DiffSegment, type SuggestionState } from "@nooq/design";
import { actorKindOf, type JobBinding } from "./controller.ts";

export { essentials } from "@nooq/plugins/essentials";
export const essentialsDOM = defineDOMPlugin({
  id: "nooq.essentials", forPlugin: essentials,
  views: essentials.contributes.blocks.map((block, i) => ({ type: block.type, mount(ctx) {
    const text = ctx.mountText({ label: block.label });
    const element = blockRow({ content: [text.element, ctx.children.element], kind: (["paragraph", "heading", "quote"] as const)[i]!, actor: "human" });
    const bar = element.querySelector<HTMLElement>(".nq-bar")!;
    return { element, update(block) {
      const writer = block.attribution.text?.actor ?? block.attribution.created.actor, actor = actorKindOf(writer);
      element.dataset.actor = actor;
      bar.className = `nq-bar nq-bar-${actor === "human" ? "human" : actor === "ai" ? "ai" : "machine"}`;
      bar.setAttribute("role", "img"); bar.setAttribute("aria-label", `Last edited by ${writer}`); bar.title = `Last edited by ${writer}`;
    }, destroy: () => text.destroy() };
  } })),
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
  views: [{ type: "nooq.suggestion/v1", mount(ctx) {
    const element = document.createElement("div"), content = document.createElement("div"); element.append(content, ctx.children.element);
    let sequence = 0;
    const refresh = async () => {
      const seq = ++sequence, state = ctx.snapshot(), block = state.blocks[ctx.block];
      if (!block) return;
      const proposal = block.fields.proposal as unknown as Proposal;
      const settled = block.fields.status as string | undefined;
      const reviewed = settled ? undefined : await ctx.review();
      if (seq !== sequence || ctx.signal.aborted) return;
      const status = (settled ?? reviewed?.evaluation.status ?? "conflicted") as SuggestionState;
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
      const created = [...state.log].reverse().find(tx => tx.ops.some(op => op.op === "insert" && op.block.id === ctx.block));
      const settlement = [...state.log].reverse().find(tx => tx.ops.some(op => op.op === "setField" && op.block === ctx.block && op.key === "status"));
      content.replaceChildren(suggestionCard({ state: status, actor: context?.name ?? proposal.actor, model: context?.model ?? proposal.actorDescriptor?.model,
        intent: created?.intent, diff: diff.length ? diff : [{ text: "no visible changes" }],
        ...(["stale", "conflicted"].includes(status) ? { reason: "The document changed while this suggestion waited." } : {}),
        evidence: proposal.evidence.map(e => ({ kind: "evidence", value: e.contentDigest.slice(7, 19) })),
        ...(settlement ? { settledBy: settlement.adoptedBy ?? settlement.actor.actorId } : {}),
        onAccept: () => { if (reviewed) void ctx.accept({ force: status !== "fresh", reviewed }).catch(ctx.report).finally(() => { void refresh().catch(ctx.report); }); },
        onReject: () => { try { ctx.reject(); } catch (cause) { ctx.report(cause); } },
      }));
    };
    ctx.onChange(() => { void refresh().catch(ctx.report); });
    return { element, update() { void refresh().catch(ctx.report); }, destroy() { sequence++; } };
  } }],
});

export interface RewriteProvider { generate(input: { text: string; signal: AbortSignal }): Promise<string> }
export function rewritePlugin(provider: RewriteProvider) {
  const job = defineJob<{ block: string }, PublicationResult>({ id: "nooq.ai.rewrite", label: "Improve this block", publishes: true,
    validateArgs: (input): input is { block: string } => !!input && typeof input === "object" && "block" in input && typeof input.block === "string",
    async run(ctx, args) {
      const base = ctx.capture(), [block] = base.readBlocks([args.block]), text = block!.text?.s ?? "";
      const generated = await provider.generate({ text, signal: ctx.signal });
      return ctx.publish(base, { ops: [{ op: "textEdit", block: args.block, changes: replaceChanges(text, generated) }], intent: "rewrite-block" });
    },
  });
  const plugin = definePlugin({ id: "nooq.ai", version: "1.0.0", apiVersion: 1, requires: { "nooq.review": "^1.0.0" }, contributes: { jobs: [job] } });
  const dom = defineDOMPlugin({ id: "nooq.ai", forPlugin: plugin, views: [], menus: [{ id: "rewrite", label: job.label, glyph: "✦", hint: "/ai", job: job.id, args: ctx => ({ block: ctx.block }) }] });
  return { plugin, job, dom };
}
export const simulatedRewrite = rewritePlugin({ async generate({ text }) { return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Written by a simulated model."; } });
export const referencePlugins = [essentials, review, simulatedRewrite.plugin] as const;
export const referenceDOM = [essentialsDOM, reviewDOM, simulatedRewrite.dom] as const;
export function referenceJobBindings(signer?: ActorKey): JobBinding[] {
  return [{ job: simulatedRewrite.job, actor: { actorId: "ai:reference", kind: "ai", model: "simulated/1" }, signer }];
}
