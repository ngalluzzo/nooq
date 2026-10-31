/** Portable plugin definitions. No DOM, CRDT, signing keys, or global registration. */
import { liveTree, makeBlock } from "@nooq/core";
import type { ActorDescriptor, Block, DocState, JsonValue, Op, RenderedText, Transaction } from "@nooq/core";
import type { Job } from "./jobs.ts";

export type ImmutableJsonValue = null | boolean | number | string | readonly ImmutableJsonValue[] | { readonly [key: string]: ImmutableJsonValue };
export type Immutable<T> = unknown extends T ? T : JsonValue extends T ? ImmutableJsonValue : T extends (...args: any[]) => any ? T
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export interface Diagnostic { field?: string; message: string }
export interface BlockDefinition {
  type: string;
  label: string;
  text: "inline" | "none";
  create(): { fields: Record<string, JsonValue>; text?: RenderedText };
  diagnose(block: Immutable<Block>): readonly Diagnostic[];
}
export interface CommandContext {
  snapshot: Immutable<DocState>;
  actor: Immutable<ActorDescriptor>;
  isAlive(id: string): boolean;
  parentOf(id: string): string | null | undefined;
  createBlock(type: string): Block;
  selection?: SelectionRequest;
}
export interface SelectionRequest { block: string; anchor: number; head: number }
export type PreparedCommand = { status: "not-applicable" } | {
  status: "ready";
  intent: string;
  ops: readonly Op[];
  selection?: SelectionRequest;
};
export type CommandResult = { status: "applied"; transaction: Transaction; selection?: SelectionRequest }
  | { status: "not-applicable" }
  | { status: "denied"; reason: string; retryable: boolean }
  | { status: "failed"; error: unknown };
export interface Command<Args> {
  id: string;
  label: string;
  validateArgs(input: unknown): input is Args;
  prepare(ctx: CommandContext, args: Args): PreparedCommand;
}
export interface Plugin {
  id: string;
  version: string;
  apiVersion: 1;
  requires?: Readonly<Record<string, string>>;
  contributes: { blocks?: readonly BlockDefinition[]; commands?: readonly Command<any>[]; jobs?: readonly Job<any, any>[] };
  setup?(context: PluginScope): void | (() => void);
}
export interface PluginError { plugin?: string; phase: "setup" | "command" | "observer" | "cleanup" | "view" | "job" | "signing"; cause: unknown }
export interface ChangeEvent {
  revision: number;
  origin: "local" | "remote";
  blocks: readonly string[];
  changes?: Readonly<Record<string, { fields: readonly string[]; text: boolean; structure: boolean }>>;
  roots?: boolean;
  access?: boolean;
  /** The exact local transaction when known; remote events may omit it. */
  transaction?: Immutable<Transaction>;
}
export interface PluginScope {
  signal: AbortSignal;
  state: Map<unknown, unknown>;
  snapshot(): Immutable<DocState>;
  onCleanup(cleanup: () => void): void;
  onChange(listener: (event: ChangeEvent) => void): () => void;
  select<T>(selector: (state: Immutable<DocState>) => T, listener: (value: T) => void, equal?: (a: T, b: T) => boolean): () => void;
}
export type DefinedPlugin<T extends Plugin = Plugin> = Readonly<T> & { readonly contributes: {
  readonly blocks: readonly BlockDefinition[]; readonly commands: readonly Command<any>[]; readonly jobs: readonly Job<any, any>[];
} };

function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
}
export function defineBlock<T extends BlockDefinition>(definition: T): Readonly<T> {
  nonempty(definition.type, "block type");
  nonempty(definition.label, "block label");
  if (!["inline", "none"].includes(definition.text) || typeof definition.create !== "function" || typeof definition.diagnose !== "function") {
    throw new Error("Invalid block definition");
  }
  return Object.freeze({ ...definition });
}
export function defineCommand<Args>(definition: Command<Args>): Readonly<Command<Args>> {
  nonempty(definition.id, "command id");
  nonempty(definition.label, "command label");
  if (typeof definition.validateArgs !== "function" || typeof definition.prepare !== "function") throw new Error("Invalid command definition");
  return Object.freeze({ ...definition });
}
export function definePlugin<T extends Plugin>(definition: T): DefinedPlugin<T> {
  nonempty(definition.id, "plugin id");
  nonempty(definition.version, "plugin version");
  if (definition.apiVersion !== 1) throw new Error("Unsupported plugin API version");
  const blocks = (definition.contributes.blocks ?? []).map(defineBlock);
  const commands = (definition.contributes.commands ?? []).map(defineCommand);
  const jobs = (definition.contributes.jobs ?? []).map(job => Object.freeze({ ...job }));
  for (const job of jobs) if (!job.id || !job.label || typeof job.validateArgs !== "function" || typeof job.run !== "function") throw new Error(`Invalid job in ${definition.id}`);
  for (const ids of [blocks.map(b => b.type), commands.map(c => c.id), jobs.map(j => j.id)]) {
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate contribution");
  }
  // Copy arrays so callers cannot mutate the registry through their original definitions.
  return Object.freeze({ ...definition, ...(definition.requires ? { requires: Object.freeze({ ...definition.requires }) } : {}), contributes: Object.freeze({ blocks: Object.freeze(blocks), commands: Object.freeze(commands), jobs: Object.freeze(jobs) }) }) as DefinedPlugin<T>;
}

export function freezeSnapshot<T>(value: T): Immutable<T> {
  const copy = structuredClone(value);
  function freeze(item: unknown): void {
    if (item && typeof item === "object" && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
  }
  freeze(copy);
  return copy as Immutable<T>;
}

/** Preparation only. The host must authorize, allocate a transaction, and commit atomically. */
export function prepareCommand(plugin: Plugin, id: string, state: DocState, actor: ActorDescriptor, input: unknown): PreparedCommand {
  const command = plugin.contributes.commands?.find(c => c.id === id);
  if (!command) throw new Error(`Unknown command: ${id}`);
  const args = freezeSnapshot(input);
  if (command.validateArgs(args) !== true) throw new Error(`Invalid arguments: ${id}`);
  const { alive, parentOf } = liveTree(state);
  const result = command.prepare({
    snapshot: freezeSnapshot(state),
    actor: freezeSnapshot({ ...actor, plugin: plugin.id }),
    isAlive: id => alive.has(id),
    parentOf: id => parentOf.get(id),
    createBlock(type) {
      const definition = plugin.contributes.blocks?.find(b => b.type === type);
      if (!definition) throw new Error(`Unknown block type: ${type}`);
      const defaults = definition.create();
      return makeBlock({ type, fields: defaults.fields, text: defaults.text }, actor.actorId);
    },
  }, args);
  if (!result || (result.status !== "ready" && result.status !== "not-applicable")) throw new Error("Command must return a synchronous result");
  if (result.status === "ready" && (!result.intent || !Array.isArray(result.ops))) throw new Error("Invalid prepared command");
  return structuredClone(result);
}
