/**
 * A lab session: the page server plus one fresh view on it. Budgets only
 * run when NQ_LAB=1 (`bun run lab`), so the repo's plain `bun test` stays fast.
 */

import { openLab, type Lab, type LabOptions } from "./harness.ts";
import type { RefDocName } from "./refdocs.ts";
import { startLabServer } from "./server.ts";

export const LAB = process.env.NQ_LAB === "1";

export interface LabSession {
  lab: Lab;
  load(doc: RefDocName): Promise<void>;
  close(): void;
}

export async function labSession(options?: LabOptions): Promise<LabSession> {
  const server = startLabServer();
  const lab = await openLab(options);
  return {
    lab,
    async load(doc) {
      await lab.open(`${server.url}?doc=${doc}`);
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
