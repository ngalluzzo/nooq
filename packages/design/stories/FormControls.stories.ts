import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { checkbox, selectField, segmentedControl, textField, toggle } from "../src/index.ts";
import { grid } from "./fixtures.ts";

/**
 * Form controls (foundation.md P0): plugin fields and host settings. Labels,
 * help and errors wire through generated ids; errors are words — the border
 * stays rule-strong, nothing turns red; checked states read as word, glyph and
 * fill together, never color alone (§9).
 */

const meta = {
  title: "Components/Form controls",
  parameters: {
    docs: {
      description: {
        component:
          "Fields for plugin settings and host forms. Provide a sentence-case `label`, `help` for the effect or constraint, and `error` as a word stating what is wrong — form errors never borrow `stamp`, which is reserved for structure that broke. Listen on `onInput` and rerender; the controls keep no state of their own. For a yes/no setting use `toggle`; for opting in, `checkbox`, whose label rides inside the control.",
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const TextField: Story = {
  render: () => textField({ label: "Model", placeholder: "qwen3-8b" }),
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByRole("textbox", { name: "Model" });
    await userEvent.click(input);
    await userEvent.keyboard("qwen3-8b");
    await expect(input).toHaveValue("qwen3-8b");
    // Keyboard focus shows the focus ring: a paper gap, then solid ink (§9).
    await expect(getComputedStyle(input).boxShadow).toMatch(/rgb/);
  },
};

export const TextFieldWithHelp: Story = {
  render: () => textField({ label: "Model", value: "qwen3-8b", help: "Which model edits this document. Every AI edit names it." }),
  play: async ({ canvas }) => {
    const input = canvas.getByRole("textbox", { name: "Model" });
    await expect(canvas.getByText("Which model edits this document. Every AI edit names it.")).toBeVisible();
    await expect(input.getAttribute("aria-describedby")).toBe(document.querySelector(".nq-field-help")!.id);
  },
};

export const TextFieldWithError: Story = {
  render: () => textField({ label: "Model", error: "This field is required." }),
  play: async ({ canvas }) => {
    const input = canvas.getByRole("textbox", { name: "Model" });
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(canvas.getByText("This field is required.")).toBeVisible();
  },
};

export const Select: Story = {
  render: () => selectField({
    label: "Export format",
    options: [
      { value: "markdown", label: "Markdown" },
      { value: "plain", label: "Plain text" },
      { value: "pdf", label: "PDF" },
    ],
    value: "markdown",
  }),
  play: async ({ canvas, userEvent }) => {
    const select = canvas.getByRole("combobox", { name: "Export format" });
    await expect(select).toHaveValue("markdown");
    await userEvent.tab();
    await expect(select).toHaveFocus();
    await expect(getComputedStyle(select).boxShadow).toMatch(/rgb/);
  },
};

export const SelectWithHelp: Story = {
  render: () => selectField({
    label: "Export format",
    options: [{ value: "plain", label: "Plain text" }],
    help: "Plain text drops marks the format cannot hold.",
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Plain text drops marks the format cannot hold.")).toBeVisible();
    await expect(canvas.getByRole("combobox", { name: "Export format" }).getAttribute("aria-describedby")).toBe(document.querySelector(".nq-field-help")!.id);
  },
};

export const SelectWithError: Story = {
  render: () => selectField({
    label: "Export format",
    options: [{ value: "plain", label: "Plain text" }, { value: "pdf", label: "PDF" }],
    error: "Choose a format with room for pending suggestions.",
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("combobox", { name: "Export format" })).toHaveAttribute("aria-invalid", "true");
    await expect(canvas.getByText("Choose a format with room for pending suggestions.")).toBeVisible();
  },
};

export const SegmentedControl: Story = {
  render: () => segmentedControl({
    label: "Theme",
    options: [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      { value: "system", label: "System" },
    ],
    value: "light",
  }),
  play: async ({ canvas, userEvent }) => {
    const light = canvas.getByRole("radio", { name: "Light" });
    const dark = canvas.getByRole("radio", { name: "Dark" });
    const system = canvas.getByRole("radio", { name: "System" });
    // One tab stop: the checked segment (§9).
    await expect(light.tabIndex).toBe(0);
    await expect(dark.tabIndex).toBe(-1);
    await expect(system.tabIndex).toBe(-1);
    await userEvent.click(light);
    await userEvent.keyboard("{ArrowRight}");
    await expect(dark).toHaveAttribute("aria-checked", "true");
    await expect(dark).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(system).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Home}");
    await expect(light).toHaveAttribute("aria-checked", "true");
    await expect(light).toHaveFocus();
  },
};

export const SegmentedControlWithHelp: Story = {
  render: () => segmentedControl({
    label: "Theme",
    options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }],
    value: "dark",
    help: "Applies on this device.",
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    await expect(canvas.getByText("Applies on this device.")).toBeVisible();
  },
};

export const SegmentedControlWithError: Story = {
  render: () => segmentedControl({
    label: "Theme",
    options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }],
    error: "Choose one of the listed themes.",
  }),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("radiogroup", { name: "Theme" })).toHaveAttribute("aria-invalid", "true");
    await expect(canvas.getByText("Choose one of the listed themes.")).toBeVisible();
  },
};

export const Toggle: Story = {
  render: () => toggle({ label: "Sign my edits" }),
  play: async ({ canvas, userEvent }) => {
    const control = canvas.getByRole("switch", { name: "Sign my edits" });
    await userEvent.tab();
    await expect(control).toHaveFocus();
    await expect(control).toHaveAttribute("aria-checked", "false");
    await expect(control.querySelector(".nq-toggle-word")).toHaveTextContent("off");
    await userEvent.keyboard(" ");
    await expect(control).toHaveAttribute("aria-checked", "true");
    await expect(control.querySelector(".nq-toggle-word")).toHaveTextContent("on");
  },
};

export const ToggleWithHelp: Story = {
  render: () => toggle({ label: "Sign my edits", checked: true, help: "Edits carry your key's signature (DM-12)." }),
  play: async ({ canvas }) => {
    const control = canvas.getByRole("switch", { name: "Sign my edits" });
    await expect(control).toHaveAttribute("aria-checked", "true");
    await expect(canvas.getByText("Edits carry your key's signature (DM-12).")).toBeVisible();
  },
};

export const ToggleWithError: Story = {
  render: () => toggle({ label: "Sign my edits", error: "This key is revoked." }),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("switch", { name: "Sign my edits" })).toHaveAttribute("aria-invalid", "true");
    await expect(canvas.getByText("This key is revoked.")).toBeVisible();
  },
};

export const Checkbox: Story = {
  render: () => checkbox({ label: "Include attachments" }),
  play: async ({ canvas, userEvent }) => {
    const control = canvas.getByRole("checkbox", { name: /Include attachments/ });
    await userEvent.tab();
    await expect(control).toHaveFocus();
    await userEvent.keyboard(" ");
    await expect(control).toHaveAttribute("aria-checked", "true");
    await expect(control.querySelector(".nq-check-word")).toHaveTextContent("on");
  },
};

export const CheckboxWithHelp: Story = {
  render: () => checkbox({ label: "Include attachments", checked: true, help: "Files travel inside the document." }),
  play: async ({ canvas }) => {
    const control = canvas.getByRole("checkbox", { name: /Include attachments/ });
    await expect(control).toHaveAttribute("aria-checked", "true");
    await expect(canvas.getByText("Files travel inside the document.")).toBeVisible();
  },
};

export const CheckboxWithError: Story = {
  render: () => checkbox({ label: "Include attachments", error: "At least one recipient must accept files." }),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("checkbox", { name: /Include attachments/ })).toHaveAttribute("aria-invalid", "true");
    await expect(canvas.getByText("At least one recipient must accept files.")).toBeVisible();
  },
};

/** A settings panel, composed: every control wires its own label, help and error. */
export const SettingsForm: Story = {
  render: () => grid(
    textField({ label: "Model", value: "qwen3-8b", help: "Which model edits this document. Every AI edit names it." }),
    selectField({
      label: "Export format",
      options: [{ value: "markdown", label: "Markdown" }, { value: "plain", label: "Plain text" }, { value: "pdf", label: "PDF" }],
      value: "markdown",
    }),
    segmentedControl({
      label: "Theme",
      options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "System" }],
      value: "system",
    }),
    toggle({ label: "Sign my edits", checked: true, help: "Edits carry your key's signature (DM-12)." }),
    checkbox({ label: "Include attachments", help: "Files travel inside the document." }),
  ),
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole("textbox", { name: "Model" })).toHaveValue("qwen3-8b");
    await expect(canvas.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await expect(canvas.getByRole("switch", { name: "Sign my edits" })).toHaveAttribute("aria-checked", "true");
    const box = canvas.getByRole("checkbox", { name: /Include attachments/ });
    await userEvent.click(box);
    await expect(box).toHaveAttribute("aria-checked", "true");
  },
};
