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
    review: { kind: "component" },
    layout: "padded",
  },
} satisfies Meta<typeof WorkspaceActivityHeatmap>

export default meta

type Story = StoryObj<typeof meta>

export const Populated: Story = {
  parameters: {
    review: {
      purpose:
        "Commit activity heatmap of a Workspace on the org home: a year of commits by day, with weekday labels.",
    },
  },
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
  parameters: {
    review: {
      purpose:
        "Commit activity heatmap of a Workspace on the org home: one day is selected and has a light outline.",
    },
  },
  args: {
    days: docsWorkspaceActivity.days,
    selectedDate: "2026-08-22",
  },
}

export const NoHistory: Story = {
  parameters: {
    review: {
      purpose:
        "Commit activity heatmap of a Workspace on the org home: the Workspace has no commits yet.",
    },
  },
  args: {
    days: emptyWorkspaceActivity.days,
  },
}

export const Loading: Story = {
  parameters: {
    review: {
      purpose:
        "Commit activity heatmap of a Workspace on the org home: the skeleton while the activity loads.",
    },
  },
  args: {
    days: [],
  },
  render: () => <WorkspaceActivityHeatmapSkeleton />,
}

export const HeatmapSkeletonMatches: Story = {
  parameters: {
    review: {
      purpose:
        "Commit activity heatmap of a Workspace: the loading skeleton and the loaded heatmap side by side, at the same size.",
    },
    intent:
      "Catches an activity heatmap skeleton whose size differs from the loaded heatmap. This causes layout shift. Not for activity counts or colors.",
  },
  tags: ["required"],
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
