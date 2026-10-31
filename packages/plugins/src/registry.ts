import { valid, validRange, satisfies } from "semver";
import { definePlugin, type Plugin, type DefinedPlugin, type BlockDefinition, type Command } from "./definitions.ts";
import type { Job } from "./jobs.ts";

export interface Contribution<T> { readonly plugin: string; readonly definition: T }
export class PluginRegistry {
  readonly plugins: readonly DefinedPlugin[];
  readonly #blocks = new Map<string, Contribution<BlockDefinition>>();
  readonly #commands = new Map<string, Contribution<Command<any>>>();
  readonly #jobs = new Map<string, Contribution<Job<any, any>>>();

  constructor(definitions: readonly Plugin[] = [], resolve: Readonly<Record<string, string>> = {}) {
    const plugins = new Map<string, DefinedPlugin>();
    for (const definition of definitions) {
      const plugin = definePlugin(definition);
      if (plugins.has(plugin.id)) throw new Error(`Duplicate plugin ${plugin.id}`);
      if (!valid(plugin.version)) throw new Error(`Plugin ${plugin.id}: invalid version ${plugin.version}`);
      plugins.set(plugin.id, plugin);
    }
    const ordered: DefinedPlugin[] = [], visiting = new Set<string>(), done = new Set<string>();
    const visit = (id: string) => {
      if (done.has(id)) return;
      if (visiting.has(id)) throw new Error(`Plugin dependency cycle at ${id}`);
      visiting.add(id);
      const plugin = plugins.get(id)!;
      for (const [required, range] of Object.entries(plugin.requires ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        const dependency = plugins.get(required);
        if (!dependency || !validRange(range) || !satisfies(dependency.version, range)) throw new Error(`Plugin ${id} requires ${required}@${range}`);
        visit(required);
      }
      visiting.delete(id); done.add(id); ordered.push(plugin);
    };
    for (const id of [...plugins.keys()].sort()) visit(id);
    this.plugins = Object.freeze(ordered);
    const slots = new Map<string, Contribution<any>[]>();
    const add = (slot: string, contribution: Contribution<any>) => slots.set(slot, [...slots.get(slot) ?? [], Object.freeze(contribution)]);
    for (const p of ordered) {
      for (const definition of p.contributes.blocks) add(`block:${definition.type}`, { plugin: p.id, definition });
      for (const definition of p.contributes.commands) add(`command:${definition.id}`, { plugin: p.id, definition });
      for (const definition of p.contributes.jobs) add(`job:${definition.id}`, { plugin: p.id, definition });
    }
    for (const [slot, owner] of Object.entries(resolve)) if (!slots.get(slot)?.some(p => p.plugin === owner)) throw new Error(`Invalid resolution ${slot} -> ${owner}`);
    for (const [slot, providers] of slots) {
      if (providers.length > 1 && !resolve[slot]) throw new Error(`Conflicting ${slot}: ${providers.map(p => p.plugin).join(", ")}`);
      const selected = resolve[slot] ? providers.find(p => p.plugin === resolve[slot])! : providers[0]!;
      const at = slot.indexOf(":"), kind = slot.slice(0, at), id = slot.slice(at + 1);
      (kind === "block" ? this.#blocks : kind === "command" ? this.#commands : this.#jobs).set(id, selected);
    }
    Object.freeze(this);
  }
  block(type: string): Contribution<BlockDefinition> | undefined { return this.#blocks.get(type); }
  command(id: string): Contribution<Command<any>> | undefined { return this.#commands.get(id); }
  job(id: string): Contribution<Job<any, any>> | undefined { return this.#jobs.get(id); }
  get blocks(): readonly Contribution<BlockDefinition>[] { return Object.freeze([...this.#blocks.values()]); }
  get commands(): readonly Contribution<Command<any>>[] { return Object.freeze([...this.#commands.values()]); }
  get jobs(): readonly Contribution<Job<any, any>>[] { return Object.freeze([...this.#jobs.values()]); }
}
