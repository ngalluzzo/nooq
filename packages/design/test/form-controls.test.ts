import "./dom.ts";
import { describe, expect, mock, test } from "bun:test";
import {
  checkbox,
  selectField,
  segmentedControl,
  textField,
  toggle,
  type FieldOption,
} from "../src/index.ts";

const OPTIONS: FieldOption[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];
const key = (target: Element, k: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const fieldParts = (field: HTMLElement) => ({
  label: field.querySelector("label.nq-field-label")!,
  help: field.querySelector(".nq-field-help"),
  error: field.querySelector(".nq-field-error"),
});

describe("textField", () => {
  test("ties the label to the input and help to aria-describedby", () => {
    const field = textField({ label: "Model", help: "Which model edits this document." });
    const { label, help } = fieldParts(field), input = field.querySelector("input")!;
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.getAttribute("aria-describedby")).toBe(help!.id);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  test("an error is a word: aria-invalid and a message, never a style change", () => {
    const field = textField({ label: "Model", help: "Which model edits this document.", error: "This field is required." });
    const { help, error } = fieldParts(field), input = field.querySelector("input")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(`${help!.id} ${error!.id}`);
    expect(error!.textContent).toBe("This field is required.");
    expect(input.getAttribute("style")).toBeNull();
  });

  test("reports what is typed", () => {
    const onInput = mock((_value: string) => {});
    const input = textField({ label: "Model", value: "qwen3-8b", onInput }).querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("qwen3-8b");
    input.value = "gpt";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onInput).toHaveBeenCalledWith("gpt");
  });
});

describe("selectField", () => {
  test("renders its options and preselects the value", () => {
    const field = selectField({ label: "Theme", options: OPTIONS, value: "dark" });
    const select = field.querySelector("select")!;
    expect(Array.from(select.querySelectorAll("option")).map(o => o.textContent)).toEqual(["Light", "Dark", "System"]);
    expect(select.value).toBe("dark");
    expect(field.querySelector("label")!.getAttribute("for")).toBe(select.id);
  });

  test("reports the choice", () => {
    const onInput = mock((_value: string) => {});
    const select = selectField({ label: "Theme", options: OPTIONS, onInput }).querySelector("select")!;
    select.value = "system";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onInput).toHaveBeenCalledWith("system");
  });

  test("an error wires aria-invalid and the message id", () => {
    const field = selectField({ label: "Theme", options: OPTIONS, error: "Choose one of the listed themes." });
    const select = field.querySelector("select")!;
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(select.getAttribute("aria-describedby")).toBe(field.querySelector(".nq-field-error")!.id);
  });
});

describe("segmentedControl", () => {
  const group = (field: HTMLElement) => field.querySelector<HTMLElement>('[role="radiogroup"]')!;
  const radios = (field: HTMLElement) => Array.from(field.querySelectorAll<HTMLElement>('[role="radio"]'));
  const checked = (field: HTMLElement) => radios(field).findIndex(r => r.getAttribute("aria-checked") === "true");

  test("is one radiogroup labelled by its label", () => {
    const field = segmentedControl({ label: "Theme", options: OPTIONS });
    expect(group(field).getAttribute("aria-labelledby")).toBe(field.querySelector(".nq-field-label")!.id);
    expect(radios(field).map(r => r.textContent)).toEqual(["Light", "Dark", "System"]);
  });

  test("the value is checked and is the single tab stop (§9)", () => {
    const field = segmentedControl({ label: "Theme", options: OPTIONS, value: "dark" });
    expect(checked(field)).toBe(1);
    expect(radios(field).map(r => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  test("arrows wrap and Home and End jump; moving selects and moves focus (§9)", () => {
    const onInput = mock((_value: string) => {});
    const field = segmentedControl({ label: "Theme", options: OPTIONS, onInput });
    document.body.append(field);
    key(group(field), "ArrowLeft");
    expect(checked(field)).toBe(2);
    expect(onInput).toHaveBeenCalledWith("system");
    expect(radios(field)[2]!).toBe(document.activeElement as HTMLElement);
    key(group(field), "ArrowRight");
    expect(checked(field)).toBe(0);
    expect(radios(field)[0]!).toBe(document.activeElement as HTMLElement);
    key(group(field), "End");
    expect(checked(field)).toBe(2);
    key(group(field), "Home");
    expect(checked(field)).toBe(0);
    field.remove();
  });

  test("clicking a segment selects it", () => {
    const onInput = mock((_value: string) => {});
    const field = segmentedControl({ label: "Theme", options: OPTIONS, onInput });
    radios(field)[2]!.click();
    expect(checked(field)).toBe(2);
    expect(onInput).toHaveBeenCalledWith("system");
  });

  test("help and error wire through the group", () => {
    const field = segmentedControl({ label: "Theme", options: OPTIONS, help: "Applies on this device.", error: "Choose one of the listed themes." });
    const described = group(field).getAttribute("aria-describedby")!;
    expect(described).toContain(field.querySelector(".nq-field-help")!.id);
    expect(described).toContain(field.querySelector(".nq-field-error")!.id);
    expect(group(field).getAttribute("aria-invalid")).toBe("true");
  });
});

describe("toggle", () => {
  test("is a switch named by its label, off by default", () => {
    const field = toggle({ label: "Sign my edits" });
    const control = field.querySelector("button")!;
    expect(control.getAttribute("role")).toBe("switch");
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(field.querySelector("label")!.getAttribute("for")).toBe(control.id);
    expect(control.querySelector(".nq-toggle-word")!.textContent).toBe("off");
  });

  test("on shows the word on, and the state never rides color alone (§9)", () => {
    const control = toggle({ label: "Sign my edits", checked: true }).querySelector("button")!;
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.querySelector(".nq-toggle-word")!.textContent).toBe("on");
  });

  test("Space and Enter flip it, reporting each new state", () => {
    const onInput = mock((_checked: boolean) => {});
    const control = toggle({ label: "Sign my edits", onInput }).querySelector("button")!;
    control.focus();
    key(control, " ");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(onInput).toHaveBeenLastCalledWith(true);
    key(control, "Enter");
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(onInput).toHaveBeenLastCalledWith(false);
    expect(control.querySelector(".nq-toggle-word")!.textContent).toBe("off");
  });
});

describe("checkbox", () => {
  test("carries its label inside and a filled/empty square as the state glyph", () => {
    const field = checkbox({ label: "Include attachments", checked: true });
    const control = field.querySelector("button")!;
    expect(control.getAttribute("role")).toBe("checkbox");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.querySelector(".nq-check-text")!.textContent).toBe("Include attachments");
    expect(control.querySelector(".nq-check-box")!.getAttribute("aria-hidden")).toBe("true");
    expect(control.querySelector(".nq-check-word")!.textContent).toBe("on");
  });

  test("Space flips it; help and error reach it by id", () => {
    const onInput = mock((_checked: boolean) => {});
    const field = checkbox({ label: "Include attachments", help: "Files travel with the document.", error: "At least one recipient must accept files.", onInput });
    const control = field.querySelector("button")!;
    const described = control.getAttribute("aria-describedby")!;
    expect(described).toContain(field.querySelector(".nq-field-help")!.id);
    expect(described).toContain(field.querySelector(".nq-field-error")!.id);
    expect(control.getAttribute("aria-invalid")).toBe("true");
    control.focus();
    key(control, " ");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.querySelector(".nq-check-word")!.textContent).toBe("on");
    expect(onInput).toHaveBeenCalledWith(true);
  });
});

describe("every control", () => {
  test("generates ids per instance, so wiring never collides", () => {
    const a = textField({ label: "One" }), b = textField({ label: "Two" });
    document.body.append(a, b);
    const inputA = a.querySelector("input")!, inputB = b.querySelector("input")!;
    expect(inputA.id).not.toBe(inputB.id);
    expect(document.getElementById(inputA.id)).toBe(inputA);
    expect(document.getElementById(inputB.id)).toBe(inputB);
    a.remove(); b.remove();
  });

  test("sets no inline styles; classes carry the whole contract", () => {
    for (const node of [
      textField({ label: "Model", error: "This field is required." }),
      selectField({ label: "Theme", options: OPTIONS, error: "Choose one of the listed themes." }),
      segmentedControl({ label: "Theme", options: OPTIONS, error: "Choose one of the listed themes." }),
      toggle({ label: "Sign my edits", error: "This key is revoked." }),
      checkbox({ label: "Include attachments", error: "At least one recipient must accept files." }),
    ].flatMap(field => Array.from(field.querySelectorAll("*")))) {
      expect(node.getAttribute("style")).toBeNull();
    }
  });
});
