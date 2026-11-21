import { expect, within } from "storybook/test"

import {
  expectSkeletonMatchesLoaded,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"
import {
  docsWorkspaceActivity,
  emptyWorkspaceActivity,
} from "@/features/workspaces/workspace-fixtures"

import preview from "../../../.storybook/preview"
import { CALENDAR_WEEKDAYS } from "./calendar-days"
import {
  WorkspaceActivityHeatmap,
  WorkspaceActivityHeatmapSkeleton,
} from "./WorkspaceActivityHeatmap"

const meta = preview.meta({
  title: "Components/Home/Activity heatmap",
  component: WorkspaceActivityHeatmap,
  parameters: {
    review: { kind: "component" },
    layout: "padded",
  },
})

/**
 * Commit activity heatmap of a Workspace on the org home: a year of commits by
 * day, with weekday labels.
 */
export const Populated = meta.story({
  args: {
    days: docsWorkspaceActivity.days,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    for (const weekday of CALENDAR_WEEKDAYS) {
      expect(await canvas.findByText(weekday)).toBeInTheDocument()
    }
  },
})

/**
 * Commit activity heatmap of a Workspace on the org home, where a member picks
 * a day to filter the commits: one day is selected and has a light outline.
 */
export const DaySelected = meta.story({
  args: {
    days: docsWorkspaceActivity.days,
    selectedDate: "2026-08-22",
  },
})

/**
 * Commit activity heatmap of a Workspace on the org home: the Workspace has no
 * commits yet.
 */
export const NoHistory = meta.story({
  args: {
    days: emptyWorkspaceActivity.days,
  },
})

/**
 * Commit activity heatmap of a Workspace on the org home: the skeleton while
 * the activity loads.
 */
export const Loading = meta.story({
  args: {
    days: [],
  },
  render: () => <WorkspaceActivityHeatmapSkeleton />,
})

/**
 * Commit activity heatmap of a Workspace: the loading skeleton and the loaded
 * heatmap side by side, at the same size.
 */
export const HeatmapSkeletonMatches = meta.story({
  parameters: {
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
})
