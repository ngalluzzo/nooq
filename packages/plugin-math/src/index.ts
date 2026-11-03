/**
 * Math blocks (Tier-2, the §7 showcase): one block type, the LaTeX source
 * as the model's own inline text, KaTeX rendering live beneath the editing
 * line — type \frac{a}{b}, see the fraction while you type. Built exactly
 * as a plugin author would: no core changes, no surface hooks, the block +
 * view + formatters are the whole contribution (the fourth public path,
 * after links, the drag handle, and code).
 */
import { defineBlock, definePlugin } from "@nooq/plugins";

export const math = defineBlock({
  type: "nooq.math/v1", label: "Math",
  text: "inline",
  create: () => ({ fields: {}, text: { s: "", marks: [] } }),
  diagnose: () => [],
});

export const mathPlugin = definePlugin({
  id: "nooq.math", version: "1.0.0", apiVersion: 1,
  contributes: { blocks: [math] },
});

export const MATH_VERSION = mathPlugin.version;
