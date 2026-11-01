/** Declarative recipes compile to the ordinary v1 block/command contracts. */
import type { JsonValue, Op } from "@nooq/core";
import { defineBlock, defineCommand, type BlockDefinition, type Command, type Diagnostic, type Immutable } from "./definitions.ts";

export interface Field<T extends JsonValue = JsonValue> {
  readonly default: T;
  readonly values?: readonly T[];
  readonly message: string;
  validate(value: unknown): value is T;
}
export type FieldSchema = Readonly<Record<string, Field>>;
export type FieldValues<S extends FieldSchema> = { -readonly [K in keyof S]: S[K] extends Field<infer V> ? V : never };
export interface SchemaBlock<S extends FieldSchema> extends BlockDefinition {
  readonly fields: S;
  create(): { fields: FieldValues<S>; text?: { s: string; marks: string[][] } };
}

function scalar<T extends string | number | boolean>(value: T, kind: string): Field<T> {
  if (typeof value !== kind || (kind === "number" && !Number.isFinite(value))) throw new Error(`Invalid ${kind} default`);
  return Object.freeze({ default: value, message: `Expected ${kind}.`,
    validate: (input: unknown): input is T => typeof input === kind && (kind !== "number" || Number.isFinite(input)),
  });
}
export const field = Object.freeze({
  string: (value = ""): Field<string> => scalar<string>(value, "string"),
  number: (value = 0): Field<number> => scalar<number>(value, "number"),
  boolean: (value = false): Field<boolean> => scalar<boolean>(value, "boolean"),
  enum<const T extends readonly [string, ...string[]]>(values: T, initial: T[number]): Field<T[number]> & { readonly values: readonly T[number][] } {
    if (!values.length || values.some(v => typeof v !== "string") || new Set(values).size !== values.length || !values.includes(initial)) throw new Error("Invalid enum values/default");
    const copy = Object.freeze([...values]);
    return Object.freeze({ default: initial, values: copy, message: `Choose ${copy.join(", ")}.`,
      validate: (value: unknown): value is T[number] => typeof value === "string" && copy.includes(value),
    });
  },
});

/** Defaults apply only at creation. Diagnostics never normalize stored content. */
export function defineBlockSchema<const S extends FieldSchema>(definition: {
  type: string; label: string; text: "inline" | "none"; textMerge?: "same-type"; fields: S; initialText?: string;
  diagnose?(block: Immutable<import("@nooq/core").Block>): readonly Diagnostic[];
}): Readonly<SchemaBlock<S>> {
  const fields = Object.freeze(Object.fromEntries(Object.entries(definition.fields).map(([key, spec]) => {
    if (!key || !spec || typeof spec.validate !== "function" || !spec.validate(spec.default)) throw new Error(`Invalid field ${key}`);
    return [key, Object.freeze({ ...spec, ...(spec.values ? { values: Object.freeze([...spec.values]) } : {}) })];
  }))) as S;
  const { type, label, text, initialText = "", diagnose } = definition;
  if (typeof initialText !== "string" || (text === "none" && initialText)) throw new Error("Invalid initial text");
  return defineBlock({ type, label, text, fields, textMerge: definition.textMerge,
    create: () => ({ fields: structuredClone(Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, spec.default]))) as FieldValues<S>,
      ...(text === "inline" ? { text: { s: initialText, marks: Array.from({ length: initialText.length }, () => [] as string[]) } } : {}),
    }),
    diagnose: block => [...Object.entries(fields).flatMap(([key, spec]) => spec.validate(block.fields[key]) ? [] : [{ field: key, message: spec.message }]), ...diagnose?.(block) ?? []],
  });
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export interface InsertBlockArgs { parent: string | null; index?: number; clearBlock?: string }

/** Fresh identities, live placement, and slash consumption in one authorized batch. */
export function insertBlockCommand(block: BlockDefinition, options: { id: string; label: string }): Command<InsertBlockArgs> {
  const type = block.type;
  return defineCommand<InsertBlockArgs>({ ...options,
    validateArgs: (a): a is InsertBlockArgs => object(a) && (a.parent === null || typeof a.parent === "string")
      && (a.index === undefined || (Number.isSafeInteger(a.index) && (a.index as number) >= 0))
      && (a.clearBlock === undefined || typeof a.clearBlock === "string"),
    prepare(ctx, args) {
      if (args.parent !== null && !ctx.isAlive(args.parent)) return { status: "not-applicable" };
      const siblings = args.parent === null ? ctx.snapshot.roots : ctx.snapshot.blocks[args.parent]!.children;
      if (args.index !== undefined && args.index > siblings.length) return { status: "not-applicable" };
      const ops: Op[] = [];
      if (args.clearBlock !== undefined) {
        if (!ctx.isAlive(args.clearBlock) || ctx.snapshot.blocks[args.clearBlock]?.text?.s !== "/") return { status: "not-applicable" };
        ops.push({ op: "textEdit", block: args.clearBlock, changes: [{ delete: 1 }] });
      }
      const created = ctx.createBlock(type);
      ops.push({ op: "insert", block: created, parent: args.parent, ...(args.index !== undefined ? { index: args.index } : {}) });
      return { status: "ready", intent: options.id, ops, ...(block.text === "inline" ? { selection: { block: created.id, anchor: 0, head: 0 } } : {}) };
    },
  });
}

export function cycleFieldCommand<S extends FieldSchema, K extends keyof S & string>(block: SchemaBlock<S>, key: K, options: { id: string; label: string }): Command<{ block: string }> {
  const spec = block.fields[key], values = spec?.values;
  if (!values?.length) throw new Error(`Field ${key} requires enum values`);
  const choices = [...values], type = block.type;
  return defineCommand<{ block: string }>({ ...options,
    validateArgs: (a): a is { block: string } => object(a) && typeof a.block === "string",
    prepare(ctx, args) {
      const target = ctx.snapshot.blocks[args.block];
      if (!ctx.isAlive(args.block) || target?.type !== type) return { status: "not-applicable" };
      const index = choices.findIndex(value => value === target.fields[key]);
      if (index < 0) return { status: "not-applicable" };
      return { status: "ready", intent: options.id, ops: [{ op: "setField", block: args.block, key, value: choices[(index + 1) % choices.length]! }] };
    },
  });
}

export function setFieldCommand<S extends FieldSchema, K extends keyof S & string>(block: SchemaBlock<S>, key: K, options: { id: string; label: string }): Command<{ block: string; value: FieldValues<S>[K] }> {
  const spec = block.fields[key], type = block.type;
  if (!spec) throw new Error(`Unknown field ${key}`);
  return defineCommand({ ...options,
    validateArgs: (a): a is { block: string; value: FieldValues<S>[K] } => object(a) && typeof a.block === "string" && spec.validate(a.value),
    prepare(ctx, args) {
      const target = ctx.snapshot.blocks[args.block];
      if (!ctx.isAlive(args.block) || target?.type !== type || target.fields[key] === args.value) return { status: "not-applicable" };
      return { status: "ready", intent: options.id, ops: [{ op: "setField", block: args.block, key, value: args.value }] };
    },
  });
}
