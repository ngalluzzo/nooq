/**
 * A lab session: the page server plus one fresh view on it. Budgets only
 * run when NQ_LAB=1 (`bun run lab`), so the repo's plain `bun test` stays fast.
 */

import { openLab, type Lab, type LabOptions } from "./harness.ts";
import type { RefDocName } from "./refdocs.ts";
import { startLabServer } from "./server.ts";

export const LAB = process.env.NQ_LAB === "1";

/**
 * NQ_LAB_GATE=report writes every result but skips the absolute budget
 * assertions, for CI while the editor is being rebuilt to meet them. The
 * regression gate (compare.ts) still applies. Default: enforce.
 */
export const ENFORCE = process.env.NQ_LAB_GATE !== "report";

export interface LabSession {
  lab: Lab;
  /** Load a reference document; `condition` is an EB-4 load condition (default idle). */
  load(doc: RefDocName, condition?: "idle" | "sync-storm"): Promise<void>;
  close(): void;
}

export async function labSession(options?: LabOptions): Promise<LabSession> {
  const server = startLabServer();
  const lab = await openLab(options);
  return {
    lab,
    async load(doc, condition = "idle") {
      await lab.open(`${server.url}?doc=${doc}&condition=${condition}`);
      const deadline = Date.now() + 30_000;
      while (!(await lab.evaluate<boolean>("document.documentElement.dataset.labReady === 'true'"))) {
        if (Date.now() > deadline) throw new Error(`lab page for ${doc} never became ready`);
        await Bun.sleep(25);
      }
      await lab.evaluate("lab.settle()");
    },
    close() {
      lab.close();
      server.stop();
    },
  };
}

export const rowSelector = (block: string) => `[data-nq-block="${block}"] textarea`;
