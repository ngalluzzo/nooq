import type { Command, SelectionRequest } from "./definitions.ts";

export type TextMode = "plain" | "rich";
export type TextMark = "strong" | "em" | "code";
/** A view's local authoring policy. Never changes admission or rewrites stored text. */
export interface TextPolicy {
  defaultMode?: TextMode;
  marks?: readonly TextMark[];
  /** Shift+Enter always inserts a newline. A command receives the current block selection. */
  enter?: "newline" | { readonly command: string };
}
export type TextPolicyDefinition = Omit<TextPolicy, "enter"> & {
  enter?: "newline" | { command: string | Command<SelectionRequest> };
};

export function defineTextPolicy(definition: TextPolicyDefinition = {}): Readonly<TextPolicy> {
  const mode = definition.defaultMode ?? "plain", marks = [...definition.marks ?? ["strong", "em", "code"]];
  if (mode !== "plain" && mode !== "rich") throw new Error("Invalid text presentation mode");
  if (marks.some(mark => !["strong", "em", "code"].includes(mark)) || new Set(marks).size !== marks.length) throw new Error("Invalid text policy marks");
  const enter = definition.enter ?? "newline";
  let normalized: NonNullable<TextPolicy["enter"]> = "newline";
  if (enter !== "newline") {
    if (!enter || typeof enter !== "object") throw new Error("Text Enter policy requires a command");
    const command = typeof enter.command === "string" ? enter.command : enter.command?.id;
    if (typeof command !== "string" || !command.trim()) throw new Error("Text Enter policy requires a command");
    normalized = Object.freeze({ command });
  }
  return Object.freeze({ defaultMode: mode, marks: Object.freeze(marks), enter: normalized });
}
