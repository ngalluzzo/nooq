import type { Meta, StoryObj } from "@storybook/html-vite";
import { expect } from "storybook/test";
import { syncStatus, type SyncState, type SyncStatusProps } from "../src/index.ts";
import { row } from "./fixtures.ts";

const STATES: SyncState[] = ["local", "offline", "syncing", "synced"];

const meta = {
  title: "Components/SyncStatus",
  render: (args) => syncStatus(args),
  args: { state: "offline", count: 0 },
  argTypes: { state: { control: "inline-radio", options: STATES }, count: { control: { type: "number", min: 0 } } },
  parameters: {
    docs: {
      description: {
        component:
          "Where the document's changes are, as one neutral line. Offline is the default state (§2): it gets the same color and weight as every other state, never red, yellow or a banner. Never block input on what it reports.",
      },
    },
  },
} satisfies Meta<SyncStatusProps>;

export default meta;
type Story = StoryObj<SyncStatusProps>;

export const Offline: Story = {};
export const Syncing: Story = { args: { state: "syncing", count: 3 } };
export const Synced: Story = { args: { state: "synced", count: 2 } };

export const AllStates: Story = {
  render: () => row(...STATES.map((state) => syncStatus({ state, count: state === "syncing" ? 3 : 2 }))),
  play: async ({ canvas }) => {
    const [local, offline, ...rest] = canvas.getAllByRole("status");
    // §2: offline looks exactly like every other state.
    for (const other of [offline!, ...rest]) await expect(getComputedStyle(other).color).toBe(getComputedStyle(local!).color);
  },
};
