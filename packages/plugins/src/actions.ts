/** Shared UI actions. Execution remains a host command or job, never an arbitrary callback. */
import type { DocState } from "@nooq/core";
import type { Command, CommandResult, Immutable, SelectionRequest } from "./definitions.ts";
import type { Job, JobHandle } from "./jobs.ts";

export interface SurfaceActionContext { block: string; snapshot: Immutable<DocState>; selection: SelectionRequest }
/** Legacy menu/key contribution; supported alongside shared actions. */
export interface SurfaceAction { id: string; label: string; command?: string; job?: string; args(context: SurfaceActionContext): unknown; glyph?: string; hint?: string }
export type ActionPlacement = "slash" | "toolbar";
export interface Action extends SurfaceAction {
  placements?: readonly ActionPlacement[];
  keys?: readonly string[];
  /** Hidden actions are absent from UI and cannot be invoked through the action service. */
  when?(context: SurfaceActionContext): boolean;
  /** Advisory availability, not authorization. Return a human-readable reason when disabled. */
  enabled?(context: SurfaceActionContext): true | string;
}
export type ActionDefinition<Args> = Omit<Action, "command" | "job" | "args"> & {
  args(context: SurfaceActionContext): NoInfer<Args>;
} & ({ command: Command<Args> | string; job?: never } | { job: Job<Args, any> | string; command?: never });
export type ActionAvailability = { status: "enabled" } | { status: "hidden" } | { status: "disabled"; reason: string };
export interface ActionState {
  id: string; label: string; glyph?: string; hint?: string; kind: "command" | "job";
  availability: ActionAvailability;
}
export type ActionResult = CommandResult | { status: "unavailable"; reason: string } | { status: "started"; job: JobHandle<unknown> };
export interface SurfaceActions {
  /** Includes hidden states so custom hosts can inspect the complete catalog. Never prepares a command. */
  list(block: string, placement?: ActionPlacement): readonly ActionState[];
  /** Re-evaluates availability and builds arguments from current state immediately before execution. */
  run(id: string, block: string): ActionResult;
}
export interface BlockActions {
  list(placement?: ActionPlacement): readonly ActionState[];
  run(id: string): ActionResult;
}
export interface ActionToolbar { element: HTMLElement; destroy(): void }

export function defineAction<Args = unknown>(definition: ActionDefinition<Args>): Readonly<Action> {
  const idOf = (target: string | { id: string } | undefined) => typeof target === "string" ? target : target?.id;
  const command = idOf(definition.command), job = idOf(definition.job);
  if (!definition.id?.trim() || !definition.label?.trim() || typeof definition.args !== "function" || !!command === !!job) throw new Error("Action requires an id, label, args and exactly one command or job");
  for (const callback of [definition.when, definition.enabled]) if (callback !== undefined && typeof callback !== "function") throw new Error(`Invalid action predicate: ${definition.id}`);
  const placements = [...definition.placements ?? []], keys = [...definition.keys ?? []];
  if (placements.some(p => p !== "slash" && p !== "toolbar") || new Set(placements).size !== placements.length) throw new Error(`Invalid action placements: ${definition.id}`);
  if (keys.some(key => typeof key !== "string" || !key.trim()) || new Set(keys).size !== keys.length) throw new Error(`Invalid action keys: ${definition.id}`);
  return Object.freeze({ ...definition, command, job, placements: Object.freeze(placements), keys: Object.freeze(keys) });
}
