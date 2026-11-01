/**
 * The working-state surface (foundation P1 "Job progress and draft preview",
 * 0008): every job whose args name a block shows who is working and Stop, with
 * the model's text deltas as a draft preview — pencil text that is visibly not
 * yet a proposal, because publication replaces it with the suggestion card
 * through the existing review flow.
 *
 * The consumer is the surface's row walk: `mount(row, blockId)` on every row
 * placement (which re-attaches across renders and windowing), `unmount` when a
 * row is released, `destroy` with the surface. Jobs for blocks with no row are
 * dropped silently; the jobs themselves keep running.
 */
import { draftPreview, workingState } from "@nooq/design";
import type { JobHandle, JobStart } from "@nooq/plugins";
import type { Editor } from "./controller.ts";

export interface JobsUI {
  /** Place any active jobs for this block inside its (possibly fresh) row. */
  mount(row: HTMLElement, blockId: string): void;
  /** Detach this block's job surfaces; the jobs themselves keep running. */
  unmount(blockId: string): void;
  destroy(): void;
}

interface ActiveJob {
  block: string;
  container: HTMLElement;
  preview: HTMLElement;
  offProgress: () => void;
}

/** A job names a block when its args carry a `block: string` (the reference rewrite contract). */
function blockOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const block = (args as { block?: unknown }).block;
  return typeof block === "string" && block ? block : undefined;
}

export function createJobsUI(editor: Editor): JobsUI {
  const active = new Set<ActiveJob>();
  const byBlock = new Map<string, ActiveJob[]>();
  const rows = new Map<string, HTMLElement>();
  let destroyed = false;

  const drop = (job: ActiveJob): void => {
    if (!active.delete(job)) return;
    const jobs = byBlock.get(job.block);
    if (jobs) { const at = jobs.indexOf(job); if (at >= 0) jobs.splice(at, 1); if (!jobs.length) byBlock.delete(job.block); }
    job.offProgress();
    job.container.remove();
  };

  const offJobs = editor.onJob(start => {
    if (destroyed) return;
    const block = blockOf(start.args);
    if (block === undefined) return; // a job that names no block has no per-block surface
    const handle: JobHandle<unknown> = start.handle;
    // DM-5: the strip names the model. A binding without a model still names
    // its actor honestly (the actor id), never nothing.
    const strip = workingState({ actor: { model: start.actor?.model ?? start.actor?.actorId ?? start.job }, onStop: () => handle.cancel() });
    const preview = draftPreview();
    const container = document.createElement("div");
    container.className = "nq-jobs";
    container.dataset.nqJob = start.job;
    container.append(strip, preview);
    // Text-so-far deltas: idempotent to render, and never announced — the
    // preview is aria-hidden; the strip's live region is the SR channel (§9).
    const offProgress = handle.onProgress(value => { if (!destroyed && typeof value === "string") preview.textContent = value; });
    const job: ActiveJob = { block, container, preview, offProgress };
    active.add(job);
    byBlock.set(block, [...byBlock.get(block) ?? [], job]);
    // Settlement — result resolves OR the abort signal wins — always cleans
    // up, whichever comes first and however the job ends.
    void handle.result.then(() => drop(job), () => drop(job));
    const row = rows.get(block);
    if (row && row.isConnected) row.append(container); // visible at once when the row is already mounted
  });

  return {
    mount(row, blockId) {
      if (destroyed) return;
      rows.set(blockId, row);
      for (const job of byBlock.get(blockId) ?? []) if (job.container.parentElement !== row) row.append(job.container);
    },
    unmount(blockId) {
      rows.delete(blockId);
      for (const job of byBlock.get(blockId) ?? []) job.container.remove();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offJobs();
      for (const job of [...active]) drop(job);
      rows.clear();
    },
  };
}
