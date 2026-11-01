/**
 * Nooq testkit: editor fixtures with no Storybook imports. The same helpers
 * mount a plugin for CSF stories, `bun test` under happy-dom, or any browser
 * runner. Every mount gets its own editor and explicit cleanup.
 */
import { Editor, createSurface } from "./index.ts";
import type { Plugin, JsonValue } from "@nooq/plugins";
import type { DOMPlugin } from "@nooq/plugins/dom";
export interface PluginStoryArgs { fields?: Record<string, JsonValue>; text?: string; children?: boolean }
const editors = new Set<Editor>();
export function mountPluginStory(plugin: Plugin, dom: DOMPlugin, args: PluginStoryArgs = {}): HTMLElement {
  const editor = new Editor({ docId: crypto.randomUUID(), actor: { actorId: "human:story" }, plugins: [plugin] });
  editors.add(editor);
  try {
    const definition = plugin.contributes.blocks![0]!, defaults = definition.create();
    const id = editor.insertBlock({ type: definition.type, parent: null, fields: args.fields ?? defaults.fields, text: args.text ?? defaults.text?.s ?? "" });
    if (args.children) editor.insertBlock({ type: "unknown.child/v1", parent: id, text: "Nested child" });
    return createSurface(editor, { plugins: [dom] }).element;
  } catch (error) { editor.close(); editors.delete(editor); throw error; }
}
export function disposePluginStories(): void { for (const editor of editors) editor.close(); editors.clear(); }
