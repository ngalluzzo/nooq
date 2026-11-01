import { liveTree } from "@nooq/core";
import type { Action, ActionAvailability, ActionPlacement, ActionResult, ActionState, ActionToolbar, SurfaceAction, SurfaceActionContext, SurfaceActions } from "@nooq/plugins/dom";
import type { Editor } from "./controller.ts";

/** One evaluator/executor for every placement; listing never prepares or allocates an edit. */
export function createActions(editor: Editor, definitions: readonly Action[], host: {
  context(block: string): SurfaceActionContext;
  blocked(dispatch: boolean): string | undefined;
  report(cause: unknown): void;
}): SurfaceActions & { invoke(action: SurfaceAction & Pick<Action, "when" | "enabled">, block: string): ActionResult } {
  const actions = new Map(definitions.map(action => [action.id, action]));
  let evaluating = false, executing = false;
  let liveness: { revision: number; alive: Set<string> } | undefined;
  function evaluate(action: Action, context: SurfaceActionContext): ActionAvailability {
    if (evaluating) throw new Error("Nested action evaluation is forbidden");
    evaluating = true;
    try {
      if (liveness?.revision !== editor.revision) liveness = { revision: editor.revision, alive: liveTree(editor.view).alive };
      if (!liveness.alive.has(context.block)) return { status: "disabled", reason: "This block is no longer available." };
      if (action.when) {
        const visible = action.when(context);
        if (typeof visible !== "boolean") throw new Error(`Action ${action.id}: when must return a boolean`);
        if (!visible) return { status: "hidden" };
      }
      const enabled = action.enabled ? action.enabled(context) : true;
      if (enabled === true) return { status: "enabled" };
      if (typeof enabled !== "string" || !enabled.trim()) throw new Error(`Action ${action.id}: enabled must return true or a reason`);
      return { status: "disabled", reason: enabled };
    } finally { evaluating = false; }
  }
  function availability(action: Action, block: string): ActionAvailability {
    try {
      const reason = host.blocked(false);
      return reason ? { status: "disabled", reason } : evaluate(action, host.context(block));
    } catch (cause) { host.report(cause); return { status: "disabled", reason: "This action is unavailable." }; }
  }
  function invoke(action: Action, block: string): ActionResult {
    if (evaluating || executing) return { status: "failed", error: new Error("Nested action dispatch is forbidden") };
    const reason = host.blocked(true);
    if (reason) return { status: "unavailable", reason };
    executing = true;
    try {
      const context = host.context(block), state = evaluate(action, context);
      if (state.status !== "enabled") return { status: "unavailable", reason: state.status === "hidden" ? "This action is hidden for this block." : state.reason };
      const args = action.args(context);
      if (action.command) return editor.commands.run(action.command, args, { selection: context.selection });
      return { status: "started", job: editor.jobs.start(action.job!, args) };
    } catch (error) { host.report(error); return { status: "failed", error }; }
    finally { executing = false; }
  }
  return {
    list(block, placement) {
      return Object.freeze([...actions.values()].filter(action => !placement || action.placements?.includes(placement)).map(action => Object.freeze({
        id: action.id, label: action.label, glyph: action.glyph, hint: action.hint, kind: action.job ? "job" as const : "command" as const,
        availability: Object.freeze(availability(action, block)),
      })));
    },
    run(id, block) {
      const action = actions.get(id);
      return action ? invoke(action, block) : { status: "failed", error: new Error(`Unknown action ${id}`) };
    }, invoke,
  };
}

let toolbarCount = 0;
/** Stable buttons preserve keyboard focus when remote changes update availability. */
export function mountActionToolbar(host: {
  list(placement: ActionPlacement): readonly ActionState[];
  run(id: string): ActionResult;
  subscribe(refresh: () => void): () => void;
}, label = "Block actions"): ActionToolbar {
  // Presentation is the nooq.css contract (.nq-action-toolbar and friends);
  // this function owns structure and behavior only — no inline styles.
  const element = document.createElement("div"), abort = new AbortController(), entries = new Map<string, { wrapper: HTMLElement; button: HTMLButtonElement; label: HTMLElement; reason: HTMLElement; hint?: HTMLElement }>();
  const prefix = `nq-actions-${++toolbarCount}`, feedback = document.createElement("span"), separator = document.createElement("span");
  feedback.setAttribute("role", "status"); feedback.className = "nq-action-feedback nq-ui-caption";
  // The separator stays the last child: a view appending its own controls to
  // the toolbar lands after the rule, visually set apart from the actions.
  separator.className = "nq-action-separator"; separator.setAttribute("aria-hidden", "true");
  element.append(feedback, separator);
  element.setAttribute("role", "toolbar"); element.setAttribute("aria-label", label); element.className = "nq-action-toolbar";
  function tabStop(preferred?: HTMLElement) {
    const enabled = [...entries.values()].map(e => e.button).filter(b => !b.disabled && !b.parentElement!.hidden);
    const active = enabled.find(b => b === preferred) ?? enabled.find(b => b === document.activeElement) ?? enabled[0];
    for (const { button } of entries.values()) button.tabIndex = button === active ? 0 : -1;
    return enabled;
  }
  function refresh() {
    if (abort.signal.aborted) return;
    const states = host.list("toolbar"), wanted = new Set(states.map(state => state.id));
    for (const [id, entry] of entries) if (!wanted.has(id)) { entry.wrapper.remove(); entries.delete(id); }
    for (const state of states) {
      let entry = entries.get(state.id);
      if (!entry) {
        const wrapper = document.createElement("div"), button = document.createElement("button"), reason = document.createElement("small"), text = document.createElement("span");
        button.type = "button"; button.dataset.nqAction = state.id; button.className = "nq-btn nq-ui-label";
        reason.id = `${prefix}-${entries.size}`; reason.className = "nq-action-reason nq-ui-caption";
        wrapper.className = "nq-action"; button.append(text); wrapper.append(button, reason); element.insertBefore(wrapper, separator);
        button.addEventListener("mousedown", event => { if (event.button === 0) event.preventDefault(); }, { signal: abort.signal });
        button.addEventListener("click", () => {
          const result = host.run(state.id);
          // Content fundamentals: name what failed and what to do. The cause
          // itself goes to the host's error channel via the runner's report.
          feedback.textContent = result.status === "failed" ? `${state.label} failed. Try again.` : result.status === "denied" || result.status === "unavailable" ? result.reason : "";
          refresh();
        }, { signal: abort.signal });
        entry = { wrapper, button, label: text, reason }; entries.set(state.id, entry);
      }
      entry.wrapper.hidden = state.availability.status === "hidden";
      if (entry.label.textContent !== state.label) entry.label.textContent = state.label;
      // A repeated action shows its shortcut as a kbd chip inside the button,
      // the same contract as @nooq/design's button (§9); the title stays.
      if (state.hint) {
        if (!entry.hint) { entry.hint = document.createElement("kbd"); entry.hint.className = "nq-kbd nq-ui-caption"; entry.button.append(entry.hint); }
        if (entry.hint.textContent !== state.hint) entry.hint.textContent = state.hint;
      } else if (entry.hint) { entry.hint.remove(); entry.hint = undefined; }
      entry.button.disabled = state.availability.status !== "enabled";
      const reason = state.availability.status === "disabled" ? state.availability.reason : "";
      if (entry.reason.textContent !== reason) entry.reason.textContent = reason;
      entry.reason.hidden = !entry.reason.textContent;
      if (entry.reason.textContent) entry.button.setAttribute("aria-describedby", entry.reason.id);
      else entry.button.removeAttribute("aria-describedby");
      entry.button.title = state.hint ?? "";
    }
    element.hidden = states.every(state => state.availability.status === "hidden");
    tabStop();
  }
  element.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = tabStop(), at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0 || !buttons.length) return;
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (at + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length;
    const next = buttons[index]!; tabStop(next); next.focus(); event.preventDefault();
  }, { signal: abort.signal });
  const off = host.subscribe(refresh); refresh();
  return { element, destroy() { if (abort.signal.aborted) return; abort.abort(); off(); element.remove(); } };
}
