import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"
import {
  docsWorkspaceActivity,
  emptyWorkspaceActivity,
} from "@/features/workspaces/workspace-fixtures"
import { CALENDAR_WEEKDAYS } from "./calendar-days"
import {
  WorkspaceActivityHeatmap,
  WorkspaceActivityHeatmapSkeleton,
} from "./WorkspaceActivityHeatmap"

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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    for (const weekday of CALENDAR_WEEKDAYS) {
      expect(await canvas.findByText(weekday)).toBeInTheDocument()
    }
  },
}

export const NoHistory: Story = {
  args: {
    days: emptyWorkspaceActivity.days,
  },
}

export const Loading: Story = {
  args: {
    days: [],
  },
  render: () => <WorkspaceActivityHeatmapSkeleton />,
}
