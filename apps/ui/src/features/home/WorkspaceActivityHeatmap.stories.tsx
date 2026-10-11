import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"
import {
  expectSkeletonMatchesLoaded,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"
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

/** The selected day has a light outline. */
export const DaySelected: Story = {
  args: {
    days: docsWorkspaceActivity.days,
    selectedDate: "2026-08-22",
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

export const HeatmapSkeletonMatches: Story = {
  tags: ["workspace-golden"],
  args: {
    days: docsWorkspaceActivity.days,
  },
  render: () => (
    <SkeletonMatchFrame
      className="w-3xl"
      skeleton={<WorkspaceActivityHeatmapSkeleton />}
      loaded={<WorkspaceActivityHeatmap days={docsWorkspaceActivity.days} />}
    />
  ),
  play: async ({ canvasElement }) => {
    await within(canvasElement).findAllByText(CALENDAR_WEEKDAYS[0])
    await expectSkeletonMatchesLoaded(canvasElement)
  },
}
