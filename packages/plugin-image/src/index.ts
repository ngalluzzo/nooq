/**
 * Image blocks (Tier-2, embeds v1): the caption is the block's TEXT — an
 * ordinary inline-text binding, signed and attributed like all text — and
 * the reference lives in fields: `src` (URL), `alt` (§9, defaulting to the
 * caption when absent), `digest?` (verifiable from day one; the blob layer
 * of proposals/0014 fills it with meaning). The fifth plugin path.
 */
import { defineBlock, definePlugin } from "@nooq/plugins";

export const image = defineBlock({
  type: "nooq.image/v1", label: "Image",
  text: "inline",
  create: () => ({ fields: { src: "" }, text: { s: "", marks: [] } }),
  diagnose: (block) => typeof block.fields.src === "string" && block.fields.src !== "" ? [] : [{ message: "The image has no source." }],
});

export const imagePlugin = definePlugin({
  id: "nooq.image", version: "1.0.0", apiVersion: 1,
  contributes: { blocks: [image] },
});

export const IMAGE_VERSION = imagePlugin.version;
