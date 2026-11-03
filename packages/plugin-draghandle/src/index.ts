/**
 * The drag handle (Tier-1, gap-audit #4) — shipped as a plugin, wearing the
 * same contribution path a third-party author would use (§7): the surface
 * hook, one command, keys. The gesture: hover a row, the grip fades in at
 * the left gutter; grab it and a branch moves as a branch — the blue line
 * says where it lands, between siblings or into a container's edge; release
 * and it lands, one transaction, undoable, replicating like every edit.
 * Concurrent drags resolve by DM-4.7 and explain themselves (DM-4.9).
 *
 * The keyboard path is the same command: Alt+Up/Alt+Down move the focused
 * block (§9 — the mouse is not the only door).
 */
import { definePlugin } from "@nooq/plugins";

export const draghandle = definePlugin({
  id: "nooq.draghandle", version: "1.0.0", apiVersion: 1,
  contributes: {},
});

export const DRAGHANDLE_VERSION = draghandle.version;
