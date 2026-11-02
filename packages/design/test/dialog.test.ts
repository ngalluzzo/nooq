import "./dom.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { dialog, type DialogAction, type DialogCloseReason, type DialogHandle } from "../src/index.ts";

const key = (target: EventTarget, k: string, shiftKey = false): KeyboardEvent => {
  const event = new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};
const press = (target: EventTarget) => target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));

/** A focused opener plus a mounted dialog; pass actions and onClose to vary the flow. */
function mounted(
  actions: readonly DialogAction[] = [],
  onClose?: (reason: DialogCloseReason) => void,
): { opener: HTMLButtonElement; handle: DialogHandle } {
  const opener = document.createElement("button");
  opener.textContent = "Open dialog";
  document.body.append(opener);
  opener.focus();
  const handle = dialog({
    title: "Delete this document?",
    body: "The document and its history are deleted from this device and every peer's.",
    actions,
    onClose,
  });
  document.body.append(handle.element);
  return { opener, handle };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("dialog", () => {
  test("renders the modal structure, labelled by its title, primary rightmost", () => {
    const { handle } = mounted([
      { label: "Export", variant: "primary" },
      { label: "Cancel", variant: "quiet" },
      { label: "Delete document", variant: "danger" },
    ]);
    const root = handle.element;
    expect(root.classList.contains("nq-dialog")).toBe(true);
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-modal")).toBe("true");
    expect(root.tabIndex).toBe(-1);
    const title = root.querySelector<HTMLElement>(".nq-dialog-title")!;
    expect(root.getAttribute("aria-labelledby")).toBe(title.id);
    expect(title.textContent).toBe("Delete this document?");
    expect(root.querySelector(".nq-dialog-body")?.textContent).toContain("deleted from this device");
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".nq-dialog-actions button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Delete document", "Export"]);
    expect(buttons[1]!.classList.contains("nq-btn-danger")).toBe(true);
    expect(buttons[2]!.classList.contains("nq-btn-primary")).toBe(true);
    handle.destroy();
  });

  test("focus opens on the first non-destructive action", async () => {
    const { handle } = mounted([
      { label: "Delete document", variant: "danger" },
      { label: "Keep it", variant: "quiet" },
    ]);
    await null; // the focus move-in lands on the next microtask
    const [, keep] = Array.from(handle.element.querySelectorAll<HTMLButtonElement>("button"));
    expect(document.activeElement).toBe(keep);
    handle.destroy();
  });

  test("focus falls back to the dialog itself when every action is destructive", async () => {
    const { handle } = mounted([{ label: "Purge", variant: "danger" }]);
    await null;
    expect(document.activeElement).toBe(handle.element);
    handle.destroy();
  });

  test("Tab and Shift+Tab stay inside, wrapping at both ends", async () => {
    const { handle } = mounted([
      { label: "Keep it", variant: "quiet" },
      { label: "Copy link" },
      { label: "Export", variant: "primary" },
    ]);
    await null;
    const [first, middle, last] = Array.from(handle.element.querySelectorAll<HTMLButtonElement>("button"));
    expect(document.activeElement).toBe(first);
    key(first, "Tab", true); // Shift+Tab at the first wraps to the last
    expect(document.activeElement).toBe(last);
    key(last, "Tab"); // Tab at the last wraps to the first
    expect(document.activeElement).toBe(first);
    // The wrap is a prevented default, so the browser's own Tab move never leaves.
    expect(key(first, "Tab", true).defaultPrevented).toBe(true);
    // In the middle, Tab stays native.
    middle.focus();
    expect(key(middle, "Tab").defaultPrevented).toBe(false);
    // From the dialog itself (the focus fallback), Tab enters at the first.
    handle.element.focus();
    key(handle.element, "Tab");
    expect(document.activeElement).toBe(first);
    handle.destroy();
  });

  test("Escape cancels, returns focus to the opener, and never triggers the destructive action", async () => {
    const onClose = mock((_reason: DialogCloseReason) => {});
    const onDelete = mock(() => {});
    const { opener, handle } = mounted(
      [
        { label: "Keep it", variant: "quiet" },
        { label: "Delete document", variant: "danger", onClick: onDelete },
      ],
      onClose,
    );
    await null;
    key(document, "Escape");
    expect(onClose).toHaveBeenCalledWith("escape");
    expect(onDelete).not.toHaveBeenCalled();
    expect(handle.element.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  test("a press outside cancels; a press inside does not", async () => {
    const onClose = mock((_reason: DialogCloseReason) => {});
    const { handle } = mounted([{ label: "Keep it", variant: "quiet" }], onClose);
    await null;
    press(handle.element.querySelector("button")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(handle.element.isConnected).toBe(true);
    press(document.body);
    expect(onClose).toHaveBeenCalledWith("outside");
    expect(handle.element.isConnected).toBe(false);
  });

  test("Escape cancels one dialog at a time, the top one first", async () => {
    const first = mounted();
    await null;
    const second = mounted();
    await null;
    key(document, "Escape");
    expect(second.handle.element.isConnected).toBe(false);
    expect(first.handle.element.isConnected).toBe(true);
    key(document, "Escape");
    expect(first.handle.element.isConnected).toBe(false);
  });

  test("activating an action runs its handler, closes the dialog, and returns focus to the opener", async () => {
    const onClose = mock((_reason: DialogCloseReason) => {});
    const onKeep = mock(() => {});
    const onDelete = mock(() => {});
    const { opener, handle } = mounted(
      [
        { label: "Keep it", variant: "quiet", onClick: onKeep },
        { label: "Delete document", variant: "danger", onClick: onDelete },
      ],
      onClose,
    );
    await null;
    const [, danger] = Array.from(handle.element.querySelectorAll<HTMLButtonElement>("button"));
    danger.click();
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
    expect(handle.element.isConnected).toBe(false); // a decision closes the dialog…
    expect(onClose).not.toHaveBeenCalled(); // …and is not a cancel
    expect(document.activeElement).toBe(opener); // focus returns to the opener
  });

  test("destroy is silent teardown that still returns focus", async () => {
    const onClose = mock((_reason: DialogCloseReason) => {});
    const { opener, handle } = mounted([{ label: "Keep it", variant: "quiet" }], onClose);
    await null;
    handle.destroy();
    expect(onClose).not.toHaveBeenCalled();
    expect(handle.element.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
    // A destroyed dialog no longer intercepts Escape.
    expect(key(document, "Escape").defaultPrevented).toBe(false);
  });
});
