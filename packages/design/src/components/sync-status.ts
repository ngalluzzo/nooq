import { el } from "../dom.ts";
import { glyph } from "../glyphs.ts";

export type SyncState = "local" | "offline" | "syncing" | "synced";

export interface SyncStatusProps {
  state: SyncState;
  /** Pending changes while syncing; connected peers once synced. */
  count?: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function syncText({ state, count = 0 }: SyncStatusProps): string {
  switch (state) {
    case "local":
      return "Saved on this device";
    case "offline":
      return "Offline · saved on this device";
    case "syncing":
      return `Syncing ${plural(count, "change")}`;
    case "synced":
      return `Synced · ${plural(count, "peer")}`;
  }
}

const GLYPH = { local: "local", offline: "offline", syncing: "stale", synced: "fresh" } as const;

/** DM-8 sync as a neutral fact. Offline is the default state (§2), never an error. */
export function syncStatus(props: SyncStatusProps): HTMLSpanElement {
  return el("span", { class: "nq-sync nq-ui-caption", role: "status", "data-state": props.state }, glyph(GLYPH[props.state]), syncText(props));
}
