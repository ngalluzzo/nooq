/**
 * A lab session: the page server plus one fresh view on it. Budgets only
 * run when NQ_LAB=1 (`bun run lab`), so the repo's plain `bun test` stays fast.
 */

import { openLab, type Lab, type LabOptions } from "./harness.ts";
import type { RefDocName } from "./refdocs.ts";
import { startLabServer } from "./server.ts";

export const LAB = process.env.NQ_LAB === "1";
const requestedMode = process.env.NQ_LAB_TEXT_MODE ?? "plain";
if (requestedMode !== "plain" && requestedMode !== "rich") throw new Error("NQ_LAB_TEXT_MODE must be plain or rich");
export const TEXT_MODE = requestedMode;

/**
 * EB-2.2: the lab needs a spawnable Bun.WebView chrome backend. Some
 * environments cannot dlopen it (ubuntu runners, confined checkouts —
 * ERR_DLOPEN_FAILED / "Failed to spawn Chrome"). The lab SKIPS there
 * rather than fail — an unmeasured environment is not a measured one,
 * and a red gate that never ran is a lie. Probed once, lazily.
 */
export const labCapable: boolean = await (async () => {
  if (!LAB) return false;
  let probe: { close?: () => void; navigate?: (url: string) => Promise<unknown> } | null = null;
  try {
    probe = new Bun.WebView({ backend: { type: "chrome", url: false }, width: 64, height: 64 }) as unknown as { close?: () => void; navigate: (url: string) => Promise<unknown> };
    // A constructor that succeeds while the pipe dies is not a capability:
    // require a real handshake.
    await Promise.race([
      probe.navigate!("about:blank"),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("probe timeout")), 5_000)),
    ]);
    probe.close?.();
    return true;
  } catch {
    probe?.close?.();
    console.warn("[lab] Bun.WebView chrome backend cannot run here — EB gates skip rather than lie (needs a spawnable Chrome/Chromium; BUN_CHROME_PATH).");
    return false;
  }
})();

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
      await lab.open(`${server.url}?doc=${doc}&condition=${condition}&textMode=${TEXT_MODE}`);
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

export const rowSelector = (block: string) => `[data-nq-block="${block}"] ${TEXT_MODE === "rich" ? '[contenteditable="true"]' : "textarea"}`;
