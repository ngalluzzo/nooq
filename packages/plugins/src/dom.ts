/** Separate entry point: importing the headless API never requires browser globals. */
import type { Block, DocState, Evaluation } from "@nooq/core";
import type { Command, CommandResult, Immutable, Plugin, SelectionRequest } from "./definitions.ts";
import { defineAction, type Action, type ActionToolbar, type BlockActions, type SurfaceAction, type SurfaceActionContext } from "./actions.ts";
import { defineTextPolicy, type TextMode, type TextMark, type TextPolicy } from "./text-policy.ts";
export * from "./actions.ts";
export * from "./text-policy.ts";
import type { DocumentTextSelection } from "./selection.ts";
export type { DocumentTextSelection, TextPoint, TextRangeSegment } from "./selection.ts";
/** A local surface selection. Range edits preserve block structure and commit atomically. */
export interface DocumentSelectionService {
  get(): DocumentTextSelection | undefined;
  set(selection: DocumentTextSelection): boolean;
  clear(): void;
  text(): string;
  replace(text: string): CommandResult;
  toggleMark(mark: TextMark): CommandResult;
}
export interface TextBinding { element: HTMLTextAreaElement; destroy(): void }
export interface TextSelection { anchor: number; head: number }
/** Host-owned rich text. Positions use UTF-16; no editor-engine objects escape. */
export interface RichTextBinding {
  element: HTMLElement;
  selection(): TextSelection;
  focus(selection?: TextSelection): void;
  toggleMark(mark: TextMark): boolean;
  destroy(): void;
}
export interface RichTextOptions { label?: string; marks?: readonly TextMark[] }
/** Presentation-neutral text binding; plain mode reports unsupported mark toggles as false. */
export interface TextEditorBinding extends RichTextBinding { readonly mode: TextMode }
export interface BlockViewContext {
  block: string;
  signal: AbortSignal;
  children: { element: HTMLElement };
  mountText(options?: { label?: string }): TextBinding;
  mountRichText(options?: RichTextOptions): RichTextBinding;
  /** Use the selected view's text policy and the application's presentation preference. */
  mountTextEditor(options?: { label?: string }): TextEditorBinding;
  actions: BlockActions;
  /** Host-owned buttons for actions placed in the toolbar, scoped to this block's lifetime. */
  mountActionToolbar(options?: { label?: string }): ActionToolbar;
  run<Args>(command: Command<Args> | string, args: Args): CommandResult;
  selection(): SelectionRequest | undefined;
  snapshot(): Immutable<DocState>;
  onChange(listener: () => void): () => void;
  review(): Promise<{ revision: number; proposal: string; evaluation: Evaluation }>;
  accept(options: { force?: boolean; reviewed: { revision: number; proposal: string } }): Promise<void>;
  reject(): void;
  report(cause: unknown): void;
}

/** Reusable slash insertion placement; actual liveness is rechecked by the command. */
export function insertAfterSelection(context: SurfaceActionContext): { parent: string | null; index: number; clearBlock: string } {
  const parent = Object.values(context.snapshot.blocks).find(block => block.children.includes(context.block))?.id ?? null;
  const siblings = parent === null ? context.snapshot.roots : context.snapshot.blocks[parent]!.children;
  return { parent, index: siblings.indexOf(context.block) + 1, clearBlock: context.block };
}
export interface BlockView {
  element: HTMLElement;
  update(block: Immutable<Block>): void;
  destroy?(): void;
}
export interface BlockViewDefinition {
  type: string;
  textPolicy?: TextPolicy;
  mount(context: BlockViewContext): BlockView;
}
export interface DOMPlugin {
  id: string;
  forPlugin: Plugin;
  views: readonly BlockViewDefinition[];
  actions?: readonly Action[];
  menus?: readonly SurfaceAction[];
  keys?: readonly (SurfaceAction & { key: string; when?(context: SurfaceActionContext): boolean })[];
  history?(snapshot: Immutable<DocState>): readonly string[];
}
export function defineDOMPlugin<T extends DOMPlugin>(plugin: T): Readonly<T> {
  if (!plugin.id || !plugin.forPlugin?.id) throw new Error("DOM plugin must name its headless plugin");
  const types = plugin.views.map(v => v.type);
  if (new Set(types).size !== types.length) throw new Error(`Duplicate view in ${plugin.id}`);
  const actions = plugin.actions?.map(action => defineAction(action as Parameters<typeof defineAction>[0]));
  if (actions && new Set(actions.map(a => a.id)).size !== actions.length) throw new Error(`Duplicate action in ${plugin.id}`);
  return Object.freeze({ ...plugin, views: Object.freeze(plugin.views.map(v => Object.freeze({ ...v,
    ...(v.textPolicy ? { textPolicy: defineTextPolicy(v.textPolicy) } : {}),
  }))),
    ...(actions ? { actions: Object.freeze(actions) } : {}),
    ...(plugin.menus ? { menus: Object.freeze(plugin.menus.map(m => Object.freeze({ ...m }))) } : {}),
    ...(plugin.keys ? { keys: Object.freeze(plugin.keys.map(k => Object.freeze({ ...k }))) } : {}),
  }) as Readonly<T>;
}
