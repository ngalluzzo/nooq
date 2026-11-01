import type { JsonValue } from "@nooq/core";
import type { Command, SelectionRequest } from "./definitions.ts";

export type TextMode = "plain" | "rich";
export type TextMark = "strong" | "em" | "code";
/**
 * Bare mark bases nooq reserves for itself (0009 §2). Every other base is
 * namespaced by the declaring plugin's id.
 */
export const RESERVED_MARK_BASES = Object.freeze(["strong", "em", "code", "link"] as const);
export type ReservedMarkBase = (typeof RESERVED_MARK_BASES)[number];
/**
 * A policy's marks are BASES (0009 §2): a reserved bare base, or a base
 * namespaced by the declaring plugin's id (the id itself, or `id.name`).
 */
export type TextBase = ReservedMarkBase | (string & {});
/** Renders one base with its payload resolved from `fields[full token]` (0009 §3). */
export type MarkRenderer = (payload: JsonValue | undefined, text: string) => Node;
/** A local authoring policy. Never changes admission or rewrites stored text. */
export interface TextPolicy {
  defaultMode?: TextMode;
  marks?: readonly TextBase[];
  /** Renderer contributions keyed by base; the rich host consumes them per surface (0009 §3). */
  renderMarks?: Readonly<Record<string, MarkRenderer>>;
  /** Shift+Enter always inserts a newline. A command receives the current block selection. */
  enter?: "newline" | { readonly command: string };
}
export type TextPolicyDefinition = Omit<TextPolicy, "enter" | "renderMarks"> & {
  enter?: "newline" | { command: string | Command<SelectionRequest> };
  renderMarks?: Record<string, MarkRenderer>;
};

/** A base is a name, never a token: nonempty, whitespace-trimmed, and without the token separator (0009 §2). */
const validBaseShape = (base: unknown): base is string =>
  typeof base === "string" && base.length > 0 && !base.includes(":") && base === base.trim();

/** The base of a stored mark: everything before the FIRST ":"; a bare mark is its own base (0009 §2). */
export function baseOf(token: string): string {
  const separator = token.indexOf(":");
  return separator === -1 ? token : token.slice(0, separator);
}

/** Does a stored mark — bare base or `base:id` token — fall inside a policy's admitted bases? */
export function tokenMatchesPolicy(token: string, policy: Pick<TextPolicy, "marks">): boolean {
  return (policy.marks ?? []).includes(baseOf(token));
}

/**
 * The 0009 §2 ownership grammar, for the DOM-plugin layer (defineTextPolicy
 * cannot see the declaring plugin): bare bases are reserved for nooq; every
 * other base must equal the plugin's id or extend it with `.name`. Poaching
 * another plugin's namespace or squatting a bare name is rejected.
 */
export function validateMarkBases(bases: readonly string[], pluginId: string): void {
  if (typeof pluginId !== "string" || !pluginId.trim()) throw new Error("Mark bases require the declaring plugin's id");
  for (const base of bases) {
    if (!validBaseShape(base)) throw new Error(`Invalid mark base ${JSON.stringify(base)}: a base is a name without ":" — tokens are base:id`);
    if ((RESERVED_MARK_BASES as readonly string[]).includes(base)) continue;
    if (base === pluginId || base.startsWith(`${pluginId}.`)) continue;
    if (base.includes(".")) throw new Error(`Mark base "${base}" is namespaced outside plugin ${pluginId}: declare ${pluginId} itself or ${pluginId}.<name>`);
    throw new Error(`Bare mark base "${base}" is reserved for nooq: namespace it as ${pluginId}.${base}`);
  }
}

export function defineTextPolicy(definition: TextPolicyDefinition = {}): Readonly<TextPolicy> {
  const mode = definition.defaultMode ?? "plain", marks = [...definition.marks ?? ["strong", "em", "code"]];
  if (mode !== "plain" && mode !== "rich") throw new Error("Invalid text presentation mode");
  // Structural only: ownership of namespaced bases is enforced by the DOM-plugin layer (0009 §2).
  if (marks.some(mark => !validBaseShape(mark)) || new Set(marks).size !== marks.length) throw new Error("Invalid text policy marks");
  const renderMarks = definition.renderMarks === undefined ? undefined : Object.freeze({ ...definition.renderMarks });
  if (renderMarks !== undefined && (Object.keys(renderMarks).some(key => !validBaseShape(key)) || Object.values(renderMarks).some(value => typeof value !== "function"))) {
    throw new Error("Invalid text policy renderMarks");
  }
  const enter = definition.enter ?? "newline";
  let normalized: NonNullable<TextPolicy["enter"]> = "newline";
  if (enter !== "newline") {
    if (!enter || typeof enter !== "object") throw new Error("Text Enter policy requires a command");
    const command = typeof enter.command === "string" ? enter.command : enter.command?.id;
    if (typeof command !== "string" || !command.trim()) throw new Error("Text Enter policy requires a command");
    normalized = Object.freeze({ command });
  }
  return Object.freeze({ defaultMode: mode, marks: Object.freeze(marks), ...(renderMarks !== undefined ? { renderMarks } : {}), enter: normalized });
}
