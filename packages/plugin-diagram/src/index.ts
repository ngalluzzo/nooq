/**
 * Diagram blocks (Tier-2, the sixth §7 path): the Mermaid source is the
 * block's TEXT — the math shape again — rendered live by pele (MIT: small,
 * synchronous, zero deps, CSS-variable theming, and a security posture built
 * for untrusted input, which remote diagram text is). The mono source line
 * above, the SVG beneath; parse errors keep the source visible with the
 * problem named (§8), never a broken block.
 */
import { defineBlock, definePlugin } from "@nooq/plugins";

export const diagram = defineBlock({
  type: "nooq.diagram/v1", label: "Diagram",
  text: "inline",
  create: () => ({ fields: {}, text: { s: "", marks: [] } }),
  diagnose: () => [],
});

export const diagramPlugin = definePlugin({
  id: "nooq.diagram", version: "1.0.0", apiVersion: 1,
  contributes: { blocks: [diagram] },
});

export const DIAGRAM_VERSION = diagramPlugin.version;
