/**
 * Form controls for plugin fields and host settings (foundation.md P0).
 *
 * Every control carries a label, optional help and an error; ids are generated
 * per instance so label, help and error wire to the control through
 * `for`/`aria-labelledby`/`aria-describedby`, with `aria-invalid` when errored.
 * An error is a word: the message sets in graphite and the field's border stays
 * rule-strong — `stamp` is reserved for structure that broke. Checked states
 * never rely on color alone: word, glyph and fill together (§9).
 */

import { el } from "../dom.ts";
import { glyph } from "../glyphs.ts";

/** Shared by every control. */
export interface FieldBase {
  /** The setting's name, sentence case: "Model", "Export format". */
  label: string;
  /** Explains the effect or the constraint; always visible. */
  help?: string;
  /** States what is wrong, as a word: "This field is required." Never red. */
  error?: string;
  disabled?: boolean;
}

/** One choice in a select or segmented control. `value` is what onInput reports. */
export interface FieldOption {
  value: string;
  label: string;
}

export interface TextFieldProps extends FieldBase {
  value?: string;
  placeholder?: string;
  onInput?: (value: string) => void;
}

export interface SelectFieldProps extends FieldBase {
  options: readonly FieldOption[];
  value?: string;
  onInput?: (value: string) => void;
}

export interface SegmentedControlProps extends FieldBase {
  options: readonly FieldOption[];
  value?: string;
  onInput?: (value: string) => void;
}

export interface ToggleProps extends FieldBase {
  checked?: boolean;
  onInput?: (checked: boolean) => void;
}

export interface CheckboxProps extends FieldBase {
  checked?: boolean;
  onInput?: (checked: boolean) => void;
}

let fieldCount = 0;

function ids(): { id: string; help: string; error: string } {
  const id = `nq-field-${++fieldCount}`;
  return { id, help: `${id}-help`, error: `${id}-error` };
}

function describedBy(helpId?: string, errorId?: string): string | undefined {
  const parts = [helpId, errorId].filter(Boolean) as string[];
  return parts.length ? parts.join(" ") : undefined;
}

function labelElement(label: string, htmlFor: string): HTMLLabelElement {
  return el("label", { class: "nq-field-label nq-ui-label", for: htmlFor }, label);
}

function labelText(label: string, id: string): HTMLSpanElement {
  return el("span", { id, class: "nq-field-label nq-ui-label" }, label);
}

function helpText(id: string, text?: string) {
  return text && el("p", { id, class: "nq-field-help nq-ui-caption" }, text);
}

function errorText(id: string, text?: string) {
  return text && el("p", { id, class: "nq-field-error nq-ui-caption" }, text);
}

/**
 * Space and Enter activate the control explicitly, so keyboard behavior is
 * complete in every host (§9). preventDefault keeps the native button click
 * from firing too — one keypress, one toggle.
 */
function keyActivate(event: Event): void {
  const e = event as KeyboardEvent;
  if (e.key !== " " && e.key !== "Enter") return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).click();
}

/** Text field. Type into it; Space is not intercepted, nothing animates. */
export function textField({ label, help, error, disabled, value, placeholder, onInput }: TextFieldProps): HTMLDivElement {
  const { id, help: helpId, error: errorId } = ids();
  return el(
    "div",
    { class: "nq-field" },
    labelElement(label, id),
    el("input", {
      id,
      type: "text",
      class: "nq-field-input nq-ui-body",
      placeholder,
      value,
      disabled,
      "aria-invalid": error ? "true" : undefined,
      "aria-describedby": describedBy(help && helpId, error && errorId),
      oninput: onInput && ((event: Event) => onInput((event.target as HTMLInputElement).value)),
    }),
    helpText(helpId, help),
    errorText(errorId, error),
  );
}

/** Select. The native control, restyled; the chevron is drawn, never a new token. */
export function selectField({ label, help, error, disabled, options, value, onInput }: SelectFieldProps): HTMLDivElement {
  const { id, help: helpId, error: errorId } = ids();
  const select = el(
    "select",
    {
      id,
      class: "nq-field-select nq-ui-body",
      disabled,
      "aria-invalid": error ? "true" : undefined,
      "aria-describedby": describedBy(help && helpId, error && errorId),
      onchange: onInput && ((event: Event) => onInput((event.target as HTMLSelectElement).value)),
    },
    options.map(option => el("option", { value: option.value }, option.label)),
  );
  if (value !== undefined) select.value = value;
  return el(
    "div",
    { class: "nq-field" },
    labelElement(label, id),
    el("div", { class: "nq-field-selectwrap" }, select, el("span", { class: "nq-field-selectglyph", "aria-hidden": "true" }, glyph("chevron"))),
    helpText(helpId, help),
    errorText(errorId, error),
  );
}

/** Segmented control: radio semantics, one tab stop, arrows wrap (§9). */
export function segmentedControl({ label, help, error, disabled, options, value, onInput }: SegmentedControlProps): HTMLDivElement {
  const { id, help: helpId, error: errorId } = ids();
  let current = Math.max(options.findIndex(option => option.value === value), options.length ? 0 : -1);
  const radios = options.map((option, i) =>
    el(
      "button",
      {
        type: "button",
        role: "radio",
        "data-value": option.value,
        class: "nq-seg-option nq-ui-label",
        disabled,
        onclick: () => {
          select(i);
          onInput?.(options[i]!.value);
        },
      },
      option.label,
    ),
  );
  function select(i: number, focus = false): void {
    current = i;
    radios.forEach((radio, j) => {
      radio.setAttribute("aria-checked", String(j === i));
      radio.tabIndex = j === i ? 0 : -1;
    });
    if (focus) radios[i]?.focus();
  }
  const group = el(
    "div",
    {
      role: "radiogroup",
      class: "nq-seg",
      "aria-labelledby": `${id}-label`,
      "aria-invalid": error ? "true" : undefined,
      "aria-describedby": describedBy(help && helpId, error && errorId),
      onkeydown: (event: Event) => {
        const e = event as KeyboardEvent, last = options.length - 1;
        const moves: Record<string, number> = {
          ArrowRight: current === last ? 0 : current + 1,
          ArrowDown: current === last ? 0 : current + 1,
          ArrowLeft: current === 0 ? last : current - 1,
          ArrowUp: current === 0 ? last : current - 1,
          Home: 0,
          End: last,
        };
        if (!(e.key in moves) || !radios.length) return;
        const next = moves[e.key]!;
        select(next, true);
        onInput?.(options[next]!.value);
        e.preventDefault();
      },
    },
    radios,
  );
  select(current);
  return el(
    "div",
    { class: "nq-field" },
    labelText(label, `${id}-label`),
    group,
    helpText(helpId, help),
    errorText(errorId, error),
  );
}

/** Toggle. role=switch; the word on/off and the square's travel carry the state (§9). */
export function toggle({ label, help, error, disabled, checked = false, onInput }: ToggleProps): HTMLDivElement {
  const { id, help: helpId, error: errorId } = ids();
  const word = el("span", { class: "nq-toggle-word nq-ui-caption" }, checked ? "on" : "off");
  const control = el(
    "button",
    {
      type: "button",
      role: "switch",
      id,
      class: "nq-toggle",
      disabled,
      "aria-checked": String(checked),
      "aria-invalid": error ? "true" : undefined,
      "aria-describedby": describedBy(help && helpId, error && errorId),
      onkeydown: keyActivate,
      onclick: () => {
        const next = control.getAttribute("aria-checked") !== "true";
        control.setAttribute("aria-checked", String(next));
        word.textContent = next ? "on" : "off";
        onInput?.(next);
      },
    },
    el("span", { class: "nq-toggle-track", "aria-hidden": "true" }, el("span", { class: "nq-toggle-thumb" })),
    word,
  );
  return el(
    "div",
    { class: "nq-field" },
    labelElement(label, id),
    control,
    helpText(helpId, help),
    errorText(errorId, error),
  );
}

/** Checkbox. The label rides inside the control, the classic checkbox row. */
export function checkbox({ label, help, error, disabled, checked = false, onInput }: CheckboxProps): HTMLDivElement {
  const { id, help: helpId, error: errorId } = ids();
  const word = el("span", { class: "nq-check-word nq-ui-caption" }, checked ? "on" : "off");
  const control = el(
    "button",
    {
      type: "button",
      role: "checkbox",
      id,
      class: "nq-check",
      disabled,
      "aria-checked": String(checked),
      "aria-invalid": error ? "true" : undefined,
      "aria-describedby": describedBy(help && helpId, error && errorId),
      onkeydown: keyActivate,
      onclick: () => {
        const next = control.getAttribute("aria-checked") !== "true";
        control.setAttribute("aria-checked", String(next));
        word.textContent = next ? "on" : "off";
        onInput?.(next);
      },
    },
    el("span", { class: "nq-check-box", "aria-hidden": "true" }),
    el("span", { class: "nq-check-text nq-ui-label" }, label),
    word,
  );
  return el(
    "div",
    { class: "nq-field" },
    control,
    helpText(helpId, help),
    errorText(errorId, error),
  );
}
