/**
 * The CM6 layer (0003's binding contract, stage 2): CodeMirror inside the
 * code block's view, the visible editor. The textarea stays the model-facing
 * binding — every CM edit mirrors into it and fires its input event, so the
 * surface's own diffing produces the splice (one keystroke, one nooq
 * transaction, EB-6's discipline untouched), remote updates flow the same
 * road back, and nooq owns undo: CM's history is simply not loaded.
 *
 * The language rides the `lang` field; grammars load lazily per language,
 * cached; unknown or unloaded modes are honest plain text until they land.
 */
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/** Theme-riding highlight colors: the palette's own variables, so light and
 *  dark follow the host with zero CM theme forks. */
const nooqHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--nq-peer-magenta)" },
  { tag: [t.string, t.special(t.string)], color: "var(--nq-peer-teal)" },
  { tag: [t.number, t.bool, t.null], color: "var(--nq-peer-violet)" },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], color: "var(--nq-ink)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--nq-peer-violet)" },
  { tag: [t.comment, t.invalid], color: "var(--nq-graphite-muted)", fontStyle: "italic" },
  { tag: [t.propertyName, t.attributeName], color: "var(--nq-peer-sepia)" },
  { tag: t.operator, color: "var(--nq-graphite)" },
  { tag: t.link, color: "var(--nq-ink)", textDecoration: "underline" },
]);

const languageCache = new Map<string, Promise<Extension | null>>();
const loadLanguage = (lang: string): Promise<Extension | null> => {
  const key = lang.toLowerCase();
  if (languageCache.has(key)) return languageCache.get(key)!;
  const loader: Record<string, () => Promise<{ extension?: Extension } & Record<string, unknown>>> = {
    js: () => import("@codemirror/lang-javascript"),
    jsx: () => import("@codemirror/lang-javascript"),
    ts: () => import("@codemirror/lang-javascript"),
    tsx: () => import("@codemirror/lang-javascript"),
    json: () => import("@codemirror/lang-json"),
    html: () => import("@codemirror/lang-html"),
    css: () => import("@codemirror/lang-css"),
    py: () => import("@codemirror/lang-python"),
    md: () => import("@codemirror/lang-markdown"),
  };
  const entry = loader[key];
  const promise = entry
    ? entry().then(mod => {
        const js = mod.javascript as ((options?: { typescript?: boolean; jsx?: boolean }) => Extension) | undefined;
        if (js !== undefined) {
          if (key === "ts") return js({ typescript: true });
          if (key === "tsx") return js({ typescript: true, jsx: true });
          if (key === "jsx") return js({ jsx: true });
          return js(); // js
        }
        // Each language package names its extension after itself.
        const factory = (mod as Record<string, unknown>)[key === "py" ? "python" : key] as (() => Extension) | undefined;
        return typeof factory === "function" ? factory() : null;
      }).catch(() => null)
    : Promise.resolve(null);
  languageCache.set(key, promise);
  return promise;
};

export interface CodeMirrorHandle {
  element: HTMLElement;
  setText(text: string, caret?: { anchor: number; head: number }): void;
  setLanguage(lang: string): void;
  focus(): void;
  destroy(): void;
}

/**
 * Mount CM beside (and through) a model-facing textarea. Every local edit
 * lands in the textarea and fires its input event — the surface's diffing
 * produces the splice; CM renders and holds the caret. Remote text arrives
 * via setText (the view's update path), guarded against echo.
 */
/** Test surface: the lazy registry. */
export const loadLanguageHandle = loadLanguage;

export function mountCodeMirror(textarea: HTMLTextAreaElement, initialText: string, initialLang: string, signal: AbortSignal): CodeMirrorHandle {
  const languages = new Compartment();
  let applying = false;
  let destroyed = false;

  const view = new EditorView({
    state: EditorState.create({
      doc: initialText,
      extensions: [
        languages.of([]),
        syntaxHighlighting(nooqHighlight),
        keymap.of([{
          key: "Tab",
          run: target => { applying = true; target.dispatch({ changes: { from: target.state.selection.main.from, to: target.state.selection.main.to, insert: "  " } }); return true; },
        }]),
        EditorView.updateListener.of(update => {
          if (destroyed) return;
          if (update.docChanged && !applying) {
            applying = true;
            try {
              textarea.value = update.state.doc.toString();
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
            } finally { applying = false; }
          }
          if (update.selectionSet && !applying) {
            const head = update.state.selection.main.head, anchor = update.state.selection.main.anchor;
            textarea.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward");
          }
        }),
        EditorView.theme({
          "&": { fontFamily: "var(--nq-font-mono)", fontSize: "14px", lineHeight: "22px", backgroundColor: "transparent", color: "inherit" },
          ".cm-content": { padding: "0", caretColor: "var(--nq-caret)" },
          ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
          "&.cm-focused": { outline: "none" },
        }),
        EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", "aria-label": "Code block" }),
      ],
    }),
    parent: undefined,
  });

  // The surface focuses the (hidden) textarea on menu actions and the like;
  // the caret belongs in CM, so focus forwards — once, no loop.
  const forward = () => { if (!destroyed) view.focus(); };
  textarea.addEventListener("focus", forward, { signal });
  // §9: a scrollable region is keyboard-scrollable (axe's rule, met at the
  // source — wide code overflows small viewports).
  view.scrollDOM.setAttribute("tabindex", "0");

  const setLanguage = (lang: string): void => {
    void loadLanguage(lang).then(extension => {
      if (destroyed) return;
      view.dispatch({ effects: languages.reconfigure(extension ? [extension as Extension] : []) });
    });
  };
  setLanguage(initialLang);

  return {
    element: view.dom,
    setText(text, caret) {
      if (destroyed) return;
      const current = view.state.doc.toString();
      if (current === text) { if (caret) view.dispatch({ selection: { anchor: caret.anchor, head: caret.head } }); return; }
      applying = true;
      try {
        const head = caret?.head ?? view.state.selection.main.head;
        const anchor = caret?.anchor ?? view.state.selection.main.anchor;
        view.dispatch({ changes: { from: 0, to: current.length, insert: text }, selection: { anchor: Math.min(anchor, text.length), head: Math.min(head, text.length) } });
      } finally { applying = false; }
    },
    setLanguage,
    focus: () => { if (!destroyed) view.focus(); },
    destroy() {
      destroyed = true;
      view.destroy();
    },
  };
}
