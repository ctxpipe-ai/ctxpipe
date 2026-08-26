import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  docsWorkspaceActivity,
  emptyWorkspaceActivity,
} from "@/features/workspaces/workspace-fixtures"
import { WorkspaceActivityHeatmap } from "./WorkspaceActivityHeatmap"

const meta = {
  title: "Components/Home/Activity heatmap",
  component: WorkspaceActivityHeatmap,
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof WorkspaceActivityHeatmap>

export default meta

type Story = StoryObj<typeof meta>

export const Populated: Story = {
  args: {
    days: docsWorkspaceActivity.days,
  },
}

export const NoHistory: Story = {
  args: {
    days: emptyWorkspaceActivity.days,
  },
}
