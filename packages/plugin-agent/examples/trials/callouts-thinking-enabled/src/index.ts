import { defineBlock, defineCommand, definePlugin } from "@nooq/plugins";

export const block = defineBlock({
  type: "seed.callout/v1",
  label: "Callout",
  text: "inline",
  create: () => ({ fields: {"tone":"info"}, text: { s: "", marks: Array.from({ length: 0 }, () => []) } }),
  // Implement diagnostics from the brief. Never repair stored content here.
  diagnose: () => [],
});

const command0 = defineCommand<{ block: string }>({
  id: "seed.callout.cycle-tone",
  label: "Cycle callout tone",
  validateArgs: (input): input is { block: string } => typeof input === "object" && input !== null && "block" in input && typeof input.block === "string",
  // Implement: Cycle tone from info to warning to success to info. Decline if missing, deleted, wrong block type, or invalid tone.
  prepare: () => ({ status: "not-applicable" }),
});

export default definePlugin({
  id: "seed.callouts", version: "0.1.0", apiVersion: 1,
  contributes: { blocks: [block], commands: [command0] },
});
