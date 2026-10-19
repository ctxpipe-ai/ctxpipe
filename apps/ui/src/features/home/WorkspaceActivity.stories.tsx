import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRouterState } from "@tanstack/react-router"
import { HttpResponse, http } from "msw"
import { I18nProvider } from "react-aria-components"
import { expect, userEvent, waitFor, within } from "storybook/test"
import type { WorkspaceActivityCommit } from "@/features/workspaces/types"
import {
  docsWorkspaceActivity,
  docsWorkspaceActivityRecent,
} from "@/features/workspaces/workspace-fixtures"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { utcDayBefore } from "./activity-search"
import { WorkspaceActivity } from "./WorkspaceActivity"

/** The query of each workspace activity request. */
const activityReads: URLSearchParams[] = []
/** The query of each org activity request. */
const orgActivityReads: URLSearchParams[] = []
/** The `date` query of each workspace activity request (`null`: no date). */
const activityDates = {
  includes: (date: string | null) =>
    activityReads.some((read) => read.get("date") === date),
}
const orgActivityDates = {
  includes: (date: string | null) =>
    orgActivityReads.some((read) => read.get("date") === date),
}

const handbookCommit = {
  sha: "f00ba47777",
  subject: "Add release checklist",
  authorName: "Lin",
  committedAt: "2026-08-22T15:00:00.000Z",
  htmlUrl: null,
  workspaceSlug: "handbook",
  workspaceName: "Handbook",
}

/**
 * The activity read like the backend: `date`, `author`, `since`, and `until`
 * filter `recent`; `limit` (default 5) and `cursor` (here an offset) page it.
 */
function activityResponse(
  params: URLSearchParams,
  commits: readonly WorkspaceActivityCommit[],
) {
  const date = params.get("date")
  const author = params.get("author")
  const since = params.get("since")
  const until = params.get("until")
  const matching = commits.filter((commit) => {
    const day = commit.committedAt.slice(0, 10)
    return (
      (!date || day === date) &&
      (!author || commit.authorName === author) &&
      (!since || day >= since) &&
      (!until || day <= until)
    )
  })
  const limit = Number(params.get("limit") ?? 5)
  const offset = Number(params.get("cursor") ?? 0)
  const next = offset + limit
  return HttpResponse.json({
    ...docsWorkspaceActivity,
    recent: matching.slice(offset, next),
    nextCursor: next < matching.length ? String(next) : null,
  })
}

/** Docs has one commit on Aug 22. The org adds one Handbook commit that day. */
function activityHandlers(docsCommits: readonly WorkspaceActivityCommit[]) {
  return [
    http.get(
      ({ request }) =>
        /\/api\/v1\/workspaces\/[^/]+\/activity$/.test(
          new URL(request.url).pathname,
        ),
      ({ request }) => {
        const params = new URL(request.url).searchParams
        activityReads.push(params)
        return activityResponse(params, docsCommits)
      },
    ),
    http.get(
      ({ request }) =>
        /\/api\/v1\/activity$/.test(new URL(request.url).pathname),
      ({ request }) => {
        const params = new URL(request.url).searchParams
        orgActivityReads.push(params)
        return activityResponse(
          params,
          [handbookCommit, ...docsCommits].sort((a, b) =>
            b.committedAt.localeCompare(a.committedAt),
          ),
        )
      },
    ),
  ]
}

const activityByDayHandlers = activityHandlers(docsWorkspaceActivityRecent)

/** Shows the search string of the story router, so a play can read the URL. */
function UrlProbe() {
  const search = useRouterState({ select: (state) => state.location.search })
  return <output data-testid="url-search">{JSON.stringify(search)}</output>
}

function urlSearch(canvasElement: HTMLElement): Record<string, unknown> {
  const probe = within(canvasElement).getByTestId("url-search")
  return JSON.parse(probe.textContent ?? "{}")
}

const meta = {
  title: "Components/Home/Activity",
  component: WorkspaceActivity,
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl space-y-10 p-8">
        <Story />
        <UrlProbe />
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
    activityReads.length = 0
    orgActivityReads.length = 0
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
 * The month labels stay in the box of the heatmap. The box keeps its height
 * while it loads, so a label below it goes over the Recent header.
 */
export const MonthLabelsStayInTheChart: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(dayCell(canvasElement, "2026-08-22")).not.toBeNull(),
    )
    const chart = dayCell(canvasElement, "2026-08-22")?.closest("svg")
    const host = chart?.parentElement
    if (!chart || !host) throw new Error("No heatmap")
    await document.fonts.ready
    const months = [...chart.querySelectorAll("text")].filter((label) =>
      /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(
        label.textContent ?? "",
      ),
    )
    expect(months.length).toBeGreaterThan(0)
    const bottom = host.getBoundingClientRect().bottom
    for (const month of months) {
      expect(month.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        bottom + 0.5,
      )
    }
  },
}

/**
 * A click on a day shows only the commits of that day and outlines the day.
 * The day goes into the URL. Reset shows the latest commits again.
 */
export const DayFiltersRecent: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )
    expect(canvas.getByText("Recent")).toBeVisible()
    expect(
      canvas.queryByRole("button", { name: "Reset" }),
    ).not.toBeInTheDocument()

    clickDay(canvasElement, "2026-08-22")

    await waitFor(() =>
      expect(canvas.getByText("Aug 22, 2026", { selector: "p" })).toBeVisible(),
    )
    await waitFor(() => expect(activityDates.includes("2026-08-22")).toBe(true))
    await waitFor(() =>
      expect(canvas.getByText("Add on-call severity notes")).toBeVisible(),
    )
    expect(
      canvas.queryByText("Document billing ledger rules"),
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        dayCell(canvasElement, "2026-08-22", "selected-day"),
      ).not.toBeNull(),
    )
    await waitFor(() =>
      expect(urlSearch(canvasElement)).toEqual({ day: "2026-08-22" }),
    )

    await userEvent.click(canvas.getByRole("button", { name: "Reset" }))

    await waitFor(() => expect(canvas.getByText("Recent")).toBeVisible())
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )
    expect(
      canvas.queryByRole("button", { name: "Reset" }),
    ).not.toBeInTheDocument()
    expect(dayCell(canvasElement, "2026-08-22", "selected-day")).toBeNull()
    await waitFor(() => expect(urlSearch(canvasElement)).toEqual({}))
  },
}

/** Enter on the focused day selects it. A day without commits says so. */
export const KeyboardSelectsEmptyDay: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )
    const chart = canvas.getByRole("img", {
      name: /Workspace commit activity/,
    })
    chart.focus()
    await userEvent.keyboard("{ArrowRight}")
    await userEvent.keyboard("{Enter}")

    await waitFor(() =>
      expect(canvas.getByText("No commits on this day.")).toBeVisible(),
    )
    const dated = activityReads
      .map((read) => read.get("date"))
      .filter((date) => date !== null)
    expect(dated).toHaveLength(1)
    expect(dated[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(canvas.getByRole("button", { name: "Reset" })).toBeVisible()
  },
}

/**
 * The author menu lists the authors of the window, each with an avatar. A
 * pick reads only the commits of that author and goes into the URL.
 */
export const AuthorFiltersRecent: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )

    await userEvent.click(
      canvas.getByRole("button", {
        name: "Filter commits by author: All authors",
      }),
    )
    const lin = await page.findByRole("menuitemradio", { name: /Lin/ })
    expect(lin).toHaveTextContent("L")
    expect(lin).toHaveTextContent("6")
    await userEvent.click(lin)

    await waitFor(() =>
      expect(
        canvas.getByRole("button", {
          name: "Filter commits by author: Lin",
        }),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(activityReads.some((read) => read.get("author") === "Lin")).toBe(
        true,
      ),
    )
    await waitFor(() =>
      expect(canvas.getByText("Clarify session cookie policy")).toBeVisible(),
    )
    expect(
      canvas.queryByText("Document billing ledger rules"),
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(urlSearch(canvasElement)).toEqual({ author: "Lin" }),
    )

    // A day works together with the author.
    clickDay(canvasElement, "2026-08-22")
    await waitFor(() =>
      expect(canvas.getByText("No commits match these filters.")).toBeVisible(),
    )
    await waitFor(() =>
      expect(urlSearch(canvasElement)).toEqual({
        author: "Lin",
        day: "2026-08-22",
      }),
    )
  },
}

/** A date range preset sends `since` and goes into the URL. */
export const DateRangeFiltersRecent: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )

    await userEvent.click(
      canvas.getByRole("button", { name: "Filter commits by date: Any time" }),
    )
    await userEvent.click(
      await page.findByRole("option", { name: "Last 30 days" }),
    )

    const since = utcDayBefore(29)
    await waitFor(() =>
      expect(
        canvas.getByRole("button", {
          name: "Filter commits by date: Last 30 days",
        }),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(activityReads.some((read) => read.get("since") === since)).toBe(
        true,
      ),
    )
    await waitFor(() => expect(urlSearch(canvasElement)).toEqual({ since }))
  },
}

/**
 * A custom range: type the first and the last day in the range picker. The
 * list reads `since` and `until`, and both go into the URL.
 */
export const CustomDateRange: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )

    await userEvent.click(
      canvas.getByRole("button", { name: "Filter commits by date: Any time" }),
    )
    const dialog = await page.findByRole("dialog", { name: "Date range" })
    const range = within(dialog).getByRole("group", { name: "Custom range" })
    const segments = within(range).getAllByRole("spinbutton")
    expect(segments).toHaveLength(6)
    await userEvent.click(segments[0] as HTMLElement)
    await userEvent.keyboard("08012026")
    await userEvent.click(segments[3] as HTMLElement)
    await userEvent.keyboard("08202026")

    await waitFor(() =>
      expect(
        activityReads.some(
          (read) =>
            read.get("since") === "2026-08-01" &&
            read.get("until") === "2026-08-20",
        ),
      ).toBe(true),
    )
    await waitFor(() =>
      expect(urlSearch(canvasElement)).toEqual({
        since: "2026-08-01",
        until: "2026-08-20",
      }),
    )
    // The open popover hides the page from assistive tech, so close it first.
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        canvas.getByRole("button", {
          name: "Filter commits by date: Aug 1, 2026 – Aug 20, 2026",
        }),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText("Refresh payments API claims")).toBeVisible(),
    )
    expect(
      canvas.queryByText("Document billing ledger rules"),
    ).not.toBeInTheDocument()
  },
}

async function openCalendar(canvasElement: HTMLElement, label: string) {
  const canvas = within(canvasElement)
  const page = within(canvasElement.ownerDocument.body)
  await userEvent.click(
    await canvas.findByRole("button", {
      name: `Filter commits by date: ${label}`,
    }),
  )
  const dialog = await page.findByRole("dialog", { name: "Date range" })
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Calendar" }),
  )
  await page.findByRole("grid")
  return page
}

/** The selected cells of the open calendar, in reading order. */
function selectedCells(page: ReturnType<typeof within>) {
  return page
    .getAllByRole("button", { hidden: true })
    .filter((cell) => cell.hasAttribute("data-selected"))
}

/** A one-day range keeps every corner round. */
export const OneDayRange: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
      search: "?since=2026-08-12&until=2026-08-12",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const page = await openCalendar(
      canvasElement,
      "Aug 12, 2026 – Aug 12, 2026",
    )
    await waitFor(() => {
      const cells = selectedCells(page)
      expect(cells).toHaveLength(1)
      expect(cells[0]).toHaveClass("rounded-s-md", "rounded-e-md")
    })
  },
}

/** A range inside one week: round start, flat middle, round end. */
export const MultiDayRange: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
      search: "?since=2026-08-10&until=2026-08-13",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const page = await openCalendar(
      canvasElement,
      "Aug 10, 2026 – Aug 13, 2026",
    )
    await waitFor(() => {
      const cells = selectedCells(page)
      expect(cells).toHaveLength(4)
      expect(cells[0]).toHaveClass("rounded-s-md")
      expect(cells[0]).not.toHaveClass("rounded-e-md")
      expect(cells[1]).toHaveClass("rounded-none")
      expect(cells[2]).toHaveClass("rounded-none")
      expect(cells[3]).toHaveClass("rounded-e-md")
      expect(cells[3]).not.toHaveClass("rounded-s-md")
    })
  },
}

/** A range over three weeks stays one connected band. */
export const RangeAcrossWeeks: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
      search: "?since=2026-08-05&until=2026-08-20",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const page = await openCalendar(canvasElement, "Aug 5, 2026 – Aug 20, 2026")
    await waitFor(() => {
      const cells = selectedCells(page)
      expect(cells).toHaveLength(16)
      expect(cells[0]).toHaveClass("rounded-s-md")
      expect(cells[8]).toHaveClass("rounded-none")
      expect(cells[15]).toHaveClass("rounded-e-md")
    })
  },
}

/** On a short window the calendar popover stays inside the viewport. */
export const CalendarOnShortViewport: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
      search: "?since=2026-08-05&until=2026-08-20",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const page = await openCalendar(canvasElement, "Aug 5, 2026 – Aug 20, 2026")
    await document.fonts.ready
    await waitFor(() => {
      const popover = page.getByRole("grid").closest("[data-trigger]")
      if (!popover) throw new Error("No calendar popover")
      const box = popover.getBoundingClientRect()
      expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
    })
  },
}

/** The field and the calendar follow the browser locale (here German). */
export const GermanLocale: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
      search: "?since=2026-08-05&until=2026-08-20",
    } satisfies StoryRouteParams,
  },
  decorators: [
    (Story) => (
      <I18nProvider locale="de-DE">
        <Story />
      </I18nProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const page = await openCalendar(canvasElement, "Aug 5, 2026 – Aug 20, 2026")
    await waitFor(() => {
      const dialog = page.getByRole("dialog", { name: "Date range" })
      const segments = within(dialog).getAllByRole("spinbutton")
      // Day comes first in German: tt.MM.jjjj.
      expect(segments[0]).toHaveTextContent("05")
      expect(segments[1]).toHaveTextContent("08")
    })
  },
}

/**
 * A reload keeps the filters: the view comes from the URL. One Reset clears
 * the author, the day, and the date range.
 */
export const ResetClearsEveryFilter: Story = {
  tags: ["workspace-golden"],
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
      search: "?author=Ada&day=2026-08-26&since=2026-08-01&until=2026-08-31",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Aug 26, 2026", { selector: "p" })).toBeVisible(),
    )
    expect(
      canvas.getByRole("button", { name: "Filter commits by author: Ada" }),
    ).toBeVisible()
    expect(
      canvas.getByRole("button", {
        name: "Filter commits by date: Aug 1, 2026 – Aug 31, 2026",
      }),
    ).toBeVisible()
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )
    const first = activityReads.find((read) => read.has("limit"))
    expect(first?.get("author")).toBe("Ada")
    expect(first?.get("date")).toBe("2026-08-26")
    expect(first?.get("since")).toBe("2026-08-01")
    expect(first?.get("until")).toBe("2026-08-31")

    await userEvent.click(canvas.getByRole("button", { name: "Reset" }))

    await waitFor(() => expect(canvas.getByText("Recent")).toBeVisible())
    expect(
      canvas.getByRole("button", {
        name: "Filter commits by author: All authors",
      }),
    ).toBeVisible()
    expect(
      canvas.getByRole("button", { name: "Filter commits by date: Any time" }),
    ).toBeVisible()
    await waitFor(() =>
      expect(canvas.getByText("Clarify session cookie policy")).toBeVisible(),
    )
    await waitFor(() => expect(urlSearch(canvasElement)).toEqual({}))
  },
}

/** Twelve Docs commits, one per day back from Aug 26. */
const twelveCommits: WorkspaceActivityCommit[] = Array.from(
  { length: 12 },
  (_, index) => ({
    sha: `${String(index).padStart(2, "0")}aa${"0".repeat(36)}`,
    subject: `Commit number ${index + 1}`,
    authorName: index % 2 ? "Lin" : "Ada",
    committedAt: new Date(Date.UTC(2026, 7, 26 - index, 12)).toISOString(),
    htmlUrl: null,
    workspaceSlug: "docs",
    workspaceName: "Docs",
  }),
)

function beadTops(canvasElement: HTMLElement): number[] {
  return [...canvasElement.querySelectorAll("[data-commit-line]")].map(
    (line) => line.getBoundingClientRect().top,
  )
}

/**
 * The list shows ten commits. Load more reads the next page with the cursor
 * and adds it under the rows; the rows above and the commit line do not move.
 */
export const LoadMorePages: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: { handlers: { page: activityHandlers(twelveCommits) } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Commit number 10")).toBeVisible(),
    )
    expect(canvas.queryByText("Commit number 11")).not.toBeInTheDocument()
    expect(canvas.getAllByRole("listitem")).toHaveLength(10)
    const before = beadTops(canvasElement)

    await userEvent.click(canvas.getByRole("button", { name: "Load more" }))

    await waitFor(() =>
      expect(canvas.getByText("Commit number 12")).toBeVisible(),
    )
    expect(canvas.getAllByRole("listitem")).toHaveLength(12)
    expect(beadTops(canvasElement).slice(0, 10)).toEqual(before)
    expect(activityReads.some((read) => read.get("cursor") === "10")).toBe(true)
    expect(
      canvas.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument()
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
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )
    const filter = canvas.getByRole("button", {
      name: "Show activity for: Docs",
    })
    expect(orgActivityReads).toEqual([])
    // Only the scope menu says "Docs"; one workspace shows no workspace names.
    expect(canvas.getAllByText("Docs")).toHaveLength(1)

    await userEvent.click(filter)
    await userEvent.click(
      await page.findByRole("menuitemradio", { name: "All workspaces" }),
    )

    await waitFor(() =>
      expect(
        canvas.getByRole("button", {
          name: "Show activity for: All workspaces",
        }),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText("Add release checklist")).toBeVisible(),
    )
    await waitFor(() => expect(canvas.getByText("Handbook")).toBeVisible())
    await waitFor(() => expect(canvas.getAllByText("Docs")[0]).toBeVisible())
    expect(orgActivityDates.includes(null)).toBe(true)
    await waitFor(() =>
      expect(urlSearch(canvasElement)).toEqual({ scope: "*" }),
    )

    clickDay(canvasElement, "2026-08-22")

    await waitFor(() =>
      expect(canvas.getByText("Aug 22, 2026", { selector: "p" })).toBeVisible(),
    )
    await waitFor(() =>
      expect(orgActivityDates.includes("2026-08-22")).toBe(true),
    )
    await waitFor(() =>
      expect(canvas.getByText("Add release checklist")).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText("Add on-call severity notes")).toBeVisible(),
    )
    expect(
      canvas.queryByText("Document billing ledger rules"),
    ).not.toBeInTheDocument()
    expect(activityDates.includes("2026-08-22")).toBe(false)
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
    // A cold first render can take longer than the default 1 s wait.
    await waitFor(
      () =>
        expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
      { timeout: 15_000 },
    )

    await userEvent.click(
      canvas.getByRole("button", { name: "Show activity for: Docs" }),
    )
    await userEvent.click(
      await page.findByRole("menuitemradio", { name: "All workspaces" }),
    )

    await waitFor(() =>
      expect(
        canvas.getByText(
          "Activity for 1 workspace is still loading: Handbook.",
        ),
      ).toBeVisible(),
    )
    await waitFor(
      () =>
        expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
      { timeout: 5_000 },
    )
    // The slow poll waits 10 s, so a 3 s window holds one heatmap read and
    // one list read only.
    await new Promise((settle) => setTimeout(settle, 3_000))
    expect(pendingOrgReads).toBe(2)
  },
}

/** All workspaces shows only the loading state while no workspace is ready. */
export const AllWorkspacesNoneReady: Story = {
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
                status: "pending",
                days: [],
                recent: [],
                pendingWorkspaces: [
                  { slug: "docs", name: "Docs" },
                  { slug: "handbook", name: "Handbook" },
                ],
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
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )

    await userEvent.click(
      canvas.getByRole("button", { name: "Show activity for: Docs" }),
    )
    await userEvent.click(
      await page.findByRole("menuitemradio", { name: "All workspaces" }),
    )

    expect(await canvas.findByText("Loading activity")).toBeInTheDocument()
    await new Promise((settle) => setTimeout(settle, 1_000))
    expect(
      canvas.queryByText("No commits on the default branch yet."),
    ).not.toBeInTheDocument()
    expect(canvas.queryByText(/is still loading/)).not.toBeInTheDocument()
  },
}
