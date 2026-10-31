import type { JsonValue } from "@nooq/core";

export interface Brief {
  id: string;
  label: string;
  description: string;
  blockType: string;
  defaults: { fields: Record<string, JsonValue>; text: string };
  diagnostics: { fields: Record<string, JsonValue>; expectedFields: string[] }[];
  insertCommand?: { id: string; label: string };
  view?: {
    textLabel: string;
    field: string;
    controls: { command: string; label: string }[];
    stories: string[];
  };
  commands: {
    id: string;
    label: string;
    description: string;
    validArgs: Record<string, JsonValue>;
    invalidArgs: JsonValue[];
    cases: {
      fields: Record<string, JsonValue>;
      args: Record<string, JsonValue>;
      expectedFields: Record<string, JsonValue> | null;
    }[];
  }[];
}

/** Briefs are the human-owned oracle. Models cannot change them through their tools. */
export function parseBrief(input: unknown): Brief {
  const b = input as Brief;
  const record = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x);
  const text = (x: unknown) => typeof x === "string" && x.length > 0 && x.length < 4000;
  if (!b || ![b.id, b.label, b.description, b.blockType].every(text)
    || !/^[a-z][a-z0-9.-]+$/.test(b.id) || !/^[a-z][a-z0-9.-]+\/v\d+$/.test(b.blockType)
    || !record(b.defaults?.fields) || typeof b.defaults?.text !== "string"
    || !Array.isArray(b.diagnostics) || !b.diagnostics.length
    || !Array.isArray(b.commands) || !b.commands.length || b.commands.length > 6) throw new Error("Invalid text-block brief");
  for (const d of b.diagnostics) {
    if (!record(d.fields) || !Array.isArray(d.expectedFields) || !d.expectedFields.every(text)) throw new Error("Invalid diagnostic case");
  }
  for (const c of b.commands) {
    if (![c.id, c.label, c.description].every(text) || !record(c.validArgs)
      || c.validArgs.block !== "$target" || !Array.isArray(c.invalidArgs) || !c.invalidArgs.length
      || !Array.isArray(c.cases) || !c.cases.length) throw new Error("Invalid command brief");
    for (const test of c.cases) {
      if (!record(test.fields) || !record(test.args) || test.args.block !== "$target"
        || (test.expectedFields !== null && !record(test.expectedFields))) throw new Error("Invalid command scenario");
    }
  }
  if (new Set(b.commands.map(c => c.id)).size !== b.commands.length) throw new Error("Duplicate brief command");
  if (b.view || b.insertCommand) {
    if (!b.insertCommand || !text(b.insertCommand.id) || !text(b.insertCommand.label)
      || b.commands.some(c => c.id === b.insertCommand!.id) || !b.view || !text(b.view.textLabel) || !text(b.view.field)
      || !Array.isArray(b.view.controls) || !b.view.controls.length || b.view.controls.some(c => !text(c.label) || !b.commands.some(command => command.id === c.command))
      || !Array.isArray(b.view.stories) || !b.view.stories.length || b.view.stories.some(s => !/^[A-Z][A-Za-z0-9]+$/.test(s))
      || new Set(b.view.stories).size !== b.view.stories.length) throw new Error("Invalid complete-plugin brief");
  }
  return structuredClone(b);
}

export function scaffold(brief: Brief): string {
  return `import { defineBlock, defineCommand, definePlugin } from "@nooq/plugins";

const block = defineBlock({
  type: ${JSON.stringify(brief.blockType)},
  label: ${JSON.stringify(brief.label)},
  text: "inline",
  create: () => ({ fields: ${JSON.stringify(brief.defaults.fields)}, text: { s: ${JSON.stringify(brief.defaults.text)}, marks: Array.from({ length: ${brief.defaults.text.length} }, () => []) } }),
  // Implement diagnostics from the brief. Never repair stored content here.
  diagnose: () => [],
});

${brief.commands.map((c, i) => `const command${i} = defineCommand<{ block: string }>({
  id: ${JSON.stringify(c.id)},
  label: ${JSON.stringify(c.label)},
  validateArgs: (input): input is { block: string } => typeof input === "object" && input !== null && "block" in input && typeof input.block === "string",
  // Implement: ${c.description.replaceAll("\n", " ")}
  prepare: () => ({ status: "not-applicable" }),
});`).join("\n\n")}

export default definePlugin({
  id: ${JSON.stringify(brief.id)}, version: "0.1.0", apiVersion: 1,
  contributes: { blocks: [block], commands: [${brief.commands.map((_, i) => `command${i}`).join(", ")}] },
});
`;
}
