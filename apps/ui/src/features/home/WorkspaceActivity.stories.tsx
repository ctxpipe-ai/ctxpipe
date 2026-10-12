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

/** The `date` query of each workspace activity request (`null`: no date). */
const activityDates: (string | null)[] = []
/** The `date` query of each org activity request (`null`: no date). */
const orgActivityDates: (string | null)[] = []

const handbookCommit = {
  sha: "f00ba47777",
  subject: "Add release checklist",
  authorName: "Lin",
  committedAt: "2026-08-22T15:00:00.000Z",
  htmlUrl: null,
  workspaceSlug: "handbook",
  workspaceName: "Handbook",
}

function activityResponse(
  date: string | null,
  recent: typeof docsWorkspaceActivityRecent,
) {
  if (date === null)
    return HttpResponse.json({ ...docsWorkspaceActivity, recent })
  return HttpResponse.json({
    ...docsWorkspaceActivity,
    recent: recent.filter((commit) => commit.committedAt.startsWith(date)),
  })
}

/** Docs has one commit on Aug 22. The org adds one Handbook commit that day. */
const activityByDayHandlers = [
  http.get(
    ({ request }) =>
      /\/api\/v1\/workspaces\/[^/]+\/activity$/.test(
        new URL(request.url).pathname,
      ),
    ({ request }) => {
      const date = new URL(request.url).searchParams.get("date")
      activityDates.push(date)
      return activityResponse(date, docsWorkspaceActivityRecent)
    },
  ),
  http.get(
    ({ request }) => /\/api\/v1\/activity$/.test(new URL(request.url).pathname),
    ({ request }) => {
      const date = new URL(request.url).searchParams.get("date")
      orgActivityDates.push(date)
      return activityResponse(
        date,
        [handbookCommit, ...docsWorkspaceActivityRecent].sort((a, b) =>
          b.committedAt.localeCompare(a.committedAt),
        ),
      )
    },
  ),
]

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
    msw: { handlers: { page: activityByDayHandlers } },
  },
  args: {
    orgSlug: "acme",
    workspaceSlug: "docs",
  },
  beforeEach: () => {
    activityDates.length = 0
    orgActivityDates.length = 0
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

/**
 * The filter starts on the composer's workspace. All workspaces shows the
 * commits of the org, each with its workspace, and a day filters them too.
 */
export const AllWorkspaces: Story = {
  args: {
    workspaces: [
      { slug: "docs", displayName: "Docs" },
      { slug: "handbook", displayName: "Handbook" },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    expect(
      await canvas.findByText("Document billing ledger rules"),
    ).toBeVisible()
    const filter = canvas.getByRole("button", {
      name: "Show activity for: Docs",
    })
    expect(orgActivityDates).toEqual([])
    expect(canvas.queryByText(/^Docs · /)).not.toBeInTheDocument()

    await userEvent.click(filter)
    await userEvent.click(
      await page.findByRole("menuitemradio", { name: "All workspaces" }),
    )

    expect(
      await canvas.findByRole("button", {
        name: "Show activity for: All workspaces",
      }),
    ).toBeVisible()
    expect(await canvas.findByText("Add release checklist")).toBeVisible()
    expect(canvas.getByText(/^Handbook · Lin · /)).toBeVisible()
    expect(canvas.getAllByText(/^Docs · Ada · /)[0]).toBeVisible()
    expect(orgActivityDates).toContain(null)

    clickDay(canvasElement, "2026-08-22")

    expect(await canvas.findByText("Aug 22, 2026")).toBeVisible()
    await waitFor(() => expect(orgActivityDates).toContain("2026-08-22"))
    expect(await canvas.findByText("Add release checklist")).toBeVisible()
    expect(canvas.getByText("Add on-call severity notes")).toBeVisible()
    expect(
      canvas.queryByText("Document billing ledger rules"),
    ).not.toBeInTheDocument()
    expect(activityDates).not.toContain("2026-08-22")
  },
}

/** All workspaces says which workspaces have activity that could not load. */
export const AllWorkspacesFailedNote: Story = {
  args: {
    workspaces: [
      { slug: "docs", displayName: "Docs" },
      { slug: "handbook", displayName: "Handbook" },
    ],
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/activity$/.test(new URL(request.url).pathname),
            () =>
              HttpResponse.json({
                ...docsWorkspaceActivity,
                failedWorkspaces: [{ slug: "handbook", name: "Handbook" }],
              }),
          ),
          ...activityByDayHandlers,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const note = "Activity for 1 workspace could not load: Handbook."
    expect(
      await canvas.findByText("Document billing ledger rules"),
    ).toBeVisible()
    expect(canvas.queryByText(note)).not.toBeInTheDocument()

    await userEvent.click(
      canvas.getByRole("button", { name: "Show activity for: Docs" }),
    )
    await userEvent.click(
      await page.findByRole("menuitemradio", { name: "All workspaces" }),
    )

    expect(await canvas.findByText(note)).toBeVisible()
    expect(canvas.getByText("Document billing ledger rules")).toBeVisible()
  },
}

let pendingOrgReads = 0

/**
 * All workspaces shows the data at once while a workspace is not ready, with a
 * note, and polls slowly. Before CTX-556 it stayed loading and polled every 2 s.
 */
export const AllWorkspacesPendingNote: Story = {
  args: {
    workspaces: [
      { slug: "docs", displayName: "Docs" },
      { slug: "handbook", displayName: "Handbook" },
    ],
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/activity$/.test(new URL(request.url).pathname),
            () => {
              pendingOrgReads += 1
              return HttpResponse.json({
                ...docsWorkspaceActivity,
                status: "pending",
                pendingWorkspaces: [{ slug: "handbook", name: "Handbook" }],
              })
            },
          ),
          ...activityByDayHandlers,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    pendingOrgReads = 0
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    expect(
      await canvas.findByText("Document billing ledger rules"),
    ).toBeVisible()

    await userEvent.click(
      canvas.getByRole("button", { name: "Show activity for: Docs" }),
    )
    await userEvent.click(
      await page.findByRole("menuitemradio", { name: "All workspaces" }),
    )

    expect(
      await canvas.findByText(
        "Activity for 1 workspace is still loading: Handbook.",
      ),
    ).toBeVisible()
    expect(canvas.getByText("Document billing ledger rules")).toBeVisible()
    // The slow poll waits 10 s, so a 3 s window holds one request only.
    await new Promise((settle) => setTimeout(settle, 3_000))
    expect(pendingOrgReads).toBe(1)
  },
}
