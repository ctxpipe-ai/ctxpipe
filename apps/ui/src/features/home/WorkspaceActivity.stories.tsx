import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  docsWorkspaceActivity,
  docsWorkspaceActivityRecent,
} from "@/features/workspaces/workspace-fixtures"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceActivity } from "./WorkspaceActivity"

/** The `date` query of each activity request, in order (`null`: no date). */
const activityDates: (string | null)[] = []

/** One commit on Aug 22. Every other day has no commits. */
const activityByDayHandler = http.get(
  ({ request }) =>
    /\/api\/v1\/workspaces\/[^/]+\/activity$/.test(
      new URL(request.url).pathname,
    ),
  ({ request }) => {
    const date = new URL(request.url).searchParams.get("date")
    activityDates.push(date)
    if (date === null) return HttpResponse.json(docsWorkspaceActivity)
    return HttpResponse.json({
      ...docsWorkspaceActivity,
      recent: docsWorkspaceActivityRecent.filter((commit) =>
        commit.committedAt.startsWith(date),
      ),
    })
  },
)

const meta = {
  title: "Components/Home/Activity",
  component: WorkspaceActivity,
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl space-y-10 p-8">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: { handlers: { page: [activityByDayHandler] } },
  },
  args: {
    orgSlug: "acme",
    workspaceSlug: "docs",
  },
  beforeEach: () => {
    activityDates.length = 0
  },
} satisfies Meta<typeof WorkspaceActivity>

export default meta

type Story = StoryObj<typeof meta>

function dayCell(canvasElement: HTMLElement, date: string, mark = "rect-0") {
  return canvasElement.querySelector<SVGRectElement>(
    `rect[data-ts-key^="${mark}:"][data-ts-key$=":${date}"]`,
  )
}

/** Click a day the way a pointer does: the chart hit-tests the coordinates. */
function clickDay(canvasElement: HTMLElement, date: string) {
  const cell = dayCell(canvasElement, date)
  if (!cell) throw new Error(`No heatmap cell for ${date}`)
  const box = cell.getBoundingClientRect()
  cell.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  )
}

/**
 * A click on a day shows only the commits of that day and outlines the day.
 * Reset view shows the latest commits again.
 */
export const DayFiltersRecent: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      await canvas.findByText("Document billing ledger rules"),
    ).toBeVisible()
    expect(canvas.getByText("Recent")).toBeVisible()
    expect(
      canvas.queryByRole("button", { name: "Reset view" }),
    ).not.toBeInTheDocument()

    clickDay(canvasElement, "2026-08-22")

    expect(await canvas.findByText("Aug 22, 2026")).toBeVisible()
    await waitFor(() => expect(activityDates).toContain("2026-08-22"))
    expect(await canvas.findByText("Add on-call severity notes")).toBeVisible()
    expect(
      canvas.queryByText("Document billing ledger rules"),
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        dayCell(canvasElement, "2026-08-22", "selected-day"),
      ).not.toBeNull(),
    )

    await userEvent.click(canvas.getByRole("button", { name: "Reset view" }))

    expect(await canvas.findByText("Recent")).toBeVisible()
    expect(canvas.getByText("Document billing ledger rules")).toBeVisible()
    expect(
      canvas.queryByRole("button", { name: "Reset view" }),
    ).not.toBeInTheDocument()
    expect(dayCell(canvasElement, "2026-08-22", "selected-day")).toBeNull()
  },
}

/** Enter on the focused day selects it. A day without commits says so. */
export const KeyboardSelectsEmptyDay: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      await canvas.findByText("Document billing ledger rules"),
    ).toBeVisible()
    const chart = canvas.getByRole("img", {
      name: /Workspace commit activity/,
    })
    chart.focus()
    await userEvent.keyboard("{ArrowRight}")
    await userEvent.keyboard("{Enter}")

    expect(await canvas.findByText("No commits on this day.")).toBeVisible()
    const dated = activityDates.filter((date) => date !== null)
    expect(dated).toHaveLength(1)
    expect(dated[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(canvas.getByRole("button", { name: "Reset view" })).toBeVisible()
  },
}
