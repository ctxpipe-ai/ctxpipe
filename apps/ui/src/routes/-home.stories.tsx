import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { emptyWorkspaceActivity } from "@/features/workspaces/workspace-fixtures"
import {
  authConfigHandler,
  organizationListWithOrgHandler,
  signedInHandlers,
} from "@/mocks/handlers"
import {
  orgActivityHandler,
  workspaceActivityHandler,
  workspaceActivityLoadingHandler,
  workspaceListHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import preview from "../../.storybook/preview"
import { OrgHomePageContent } from "./$orgSlug.index"

const meta = preview.meta({
  title: "Pages/Home",
  tags: ["page"],
  beforeEach: ({ msw }) => {
    // The user is a member, so the setup guide of an admin does not load.
    msw.use(
      ...signedInHandlers,
      activeMemberRoleHandler("member"),
      pendingWorkspaceUpgradesHandler({}),
      ...workspaceIngestionHandlers({}),
    )
  },
  parameters: {
    app: "org",
    layout: "fullscreen",
    review: { kind: "page" },
    route: "/$orgSlug/",
  },
})

const homeRoute = {
  pattern: "orgIndex",
  orgSlug: "acme",
} satisfies StoryRouteParams

/**
 * Org home page, where a member asks the agent and opens a Workspace: the
 * session is still loading.
 */
export const Loading = meta.story({
  tags: ["required"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    expect(canvas.getByLabelText("Select workspace")).toBeVisible()
    expect(canvas.getByText("Loading activity")).toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create Workspace" }),
    ).not.toBeInTheDocument()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      // Wins over the signed-in user of the meta so the session request hangs.
      authConfigHandler,
      http.get("*/.auth/api/v1/auth/get-session", async () => {
        await delay("infinite")
        return HttpResponse.json(null)
      }),
      organizationListWithOrgHandler,
      workspaceListHandler([]),
    )
  },
  parameters: {
    intent:
      "Catches an org home that shows content or a Create button while the session loads. The shell shows the selector and the activity loading text. Not for loaded data.",
    storyRoute: homeRoute,
  },
})

/**
 * Home, where a member asks the agent and sees the commits of a Workspace: the
 * Workspace list still loads, so the activity shows its loading state. The
 * composer and the activity skeleton hold their place, and no Create Workspace
 * button shows.
 */
export const WorkspacesLoading = meta.story({
  tags: ["required"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    await waitFor(() =>
      expect(canvas.getByLabelText("Select workspace")).toBeVisible(),
    )
    expect(canvas.getByText("Loading activity")).toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create Workspace" }),
    ).not.toBeInTheDocument()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
        async () => {
          await delay("infinite")
          return HttpResponse.json({ items: [], lastUsedWorkspaceId: null })
        },
      ),
    )
  },
  parameters: {
    // At the mobile width the screenshot is the same as Loading.
    visual: { viewports: ["desktop"] },
    intent:
      "Catches an org home that shows a Create button while workspaces load. It shows the selector and the activity loading text. Not for loaded workspaces or errors.",
    storyRoute: homeRoute,
  },
})

/** The user dismissed the setup guide of the org. */
function dismissGuide() {
  window.localStorage.setItem(
    "ctxpipe:userPreferences",
    JSON.stringify({
      orgGuides: {
        "user_storybook:acme": { dismissedAt: "2026-01-01T00:00:00.000Z" },
      },
    }),
  )
}

/**
 * Org home page, where a member asks the agent and opens a Workspace: the org
 * has no Workspace and the user dismissed the guide, so the Create Workspace
 * button shows above the empty activity.
 */
export const Empty = meta.story({
  tags: ["required"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  beforeEach: ({ msw }) => {
    msw.use(workspaceListHandler([]), orgActivityHandler())
    dismissGuide()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Create Workspace" }),
      ).toBeVisible(),
    )
    // The activity of the organization shows, empty.
    await waitFor(() => expect(canvas.getByText("Activity")).toBeVisible())
    await waitFor(() =>
      expect(
        canvas.getByText("No commits on the default branch yet."),
      ).toBeVisible(),
    )
  },
  parameters: {
    intent:
      "Catches an org home with no workspace that shows no way to start. It shows Create Workspace and the empty activity. Not for populated homes or the guide.",
    storyRoute: homeRoute,
  },
})

let listReadFails = true

/**
 * Org home page, where a member asks the agent and opens a Workspace: the
 * Workspace list failed to load, so an alert with Retry shows. Home shows no
 * Create Workspace button and no setup guide, because they would say that the
 * org has no Workspace.
 */
export const WorkspacesLoadFails = meta.story({
  tags: ["required"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
        () =>
          listReadFails
            ? HttpResponse.json({ error: "boom" }, { status: 500 })
            : HttpResponse.json({ items: [], lastUsedWorkspaceId: null }),
      ),
      orgActivityHandler(),
    )

    listReadFails = true
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    const alert = await canvas.findByRole("alert", {}, { timeout: 15_000 })
    expect(within(alert).getByText("Could not load Workspaces")).toBeVisible()
    expect(
      canvas.queryByRole("button", { name: "Create Workspace" }),
    ).not.toBeInTheDocument()
    expect(canvas.queryByLabelText("Get started")).not.toBeInTheDocument()
    expect(canvas.queryByLabelText("Setup progress")).not.toBeInTheDocument()
    listReadFails = false
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(canvas.queryByRole("alert")).toBeNull())
    // The side nav reads the same list. The Retry on Home also clears the
    // error of the side nav, when the side nav got the failure: its list
    // shows again.
    await canvas.findByLabelText("Add Workspace")
    expect(canvas.queryByText("Could not load Workspaces.")).toBeNull()
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Empty." },
    intent:
      "Catches a failed workspace list that shows the guide or a Create button. It shows an alert with Retry, and Retry loads the home again. Not for loaded lists.",
    storyRoute: homeRoute,
  },
})

/**
 * Org home page, where a member asks the agent and opens a Workspace: the org
 * has no Workspace, so Recent shows its empty text at once while the activity
 * heatmap still loads. Recent shows no commit rows that then go away.
 */
export const EmptyRecentWhileActivityLoads = meta.story({
  tags: ["required"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([]),
      http.get(
        ({ request }) =>
          /\/api\/v1\/activity$/.test(new URL(request.url).pathname),
        async () => {
          await delay("infinite")
          return HttpResponse.json(emptyWorkspaceActivity)
        },
      ),
    )
    dismissGuide()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    await waitFor(() =>
      expect(
        canvas.getByText("No commits on the default branch yet."),
      ).toBeVisible(),
    )
    expect(canvas.getByText("Loading activity")).toBeInTheDocument()
    await waitFor(() =>
      expect(canvas.queryByText("Loading recent commits")).toBeNull(),
    )
  },
  parameters: {
    intent:
      "Catches a recent commits area that shows a loading state when the workspace list is empty. The empty text shows while activity still loads. Not for populated homes.",
    storyRoute: homeRoute,
  },
})

/**
 * Org home page, where a member asks the agent and opens a Workspace: the org
 * has Workspaces with activity and recent commits.
 */
export const Populated = meta.story({
  tags: ["required"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    expect(canvas.getByLabelText("Select workspace")).toBeVisible()
    const activityHeading = await canvas.findByText("Activity")
    expect(activityHeading).toBeVisible()
    expect(activityHeading).toHaveClass("tracking-normal")
    expect(activityHeading).not.toHaveClass("ctx-label")
    expect(canvas.getByText("Recent")).toHaveClass("tracking-normal")
    await waitFor(() =>
      expect(canvas.getByText("Document billing ledger rules")).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers())
  },
  parameters: {
    intent:
      "Catches an org home that shows wrong headings or no commits. It shows the selector, Activity and Recent headings in the plain style, and recent commits. Not for loading states.",
    storyRoute: homeRoute,
  },
})

/**
 * Org home page, where a member asks the agent and opens a Workspace: Activity
 * and Recent keep the same 40 px gap as the other Home blocks. The
 * view-transition wrapper around them must not remove that gap.
 */
export const ActivityAndRecentKeepTheirGap = meta.story({
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const activity = (
      await canvas.findByText("Activity", {}, { timeout: 15_000 })
    ).closest("section")
    const recent = (await canvas.findByText("Recent")).closest("section")
    if (!activity || !recent) throw new Error("No Activity or Recent section")
    await document.fonts.ready
    const gap =
      recent.getBoundingClientRect().top -
      activity.getBoundingClientRect().bottom
    expect(gap).toBeGreaterThanOrEqual(39.5)
  },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers())
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Populated." },
    storyRoute: homeRoute,
  },
})

/**
 * Org home page, where a member asks the agent and opens a Workspace: the
 * activity is still loading while the selector shows.
 */
export const ActivityLoading = meta.story({
  tags: ["required"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    expect(canvas.getByLabelText("Select workspace")).toBeVisible()
    expect(await canvas.findByText("Loading activity")).toBeInTheDocument()
    expect(canvas.queryByText("Loading…")).not.toBeInTheDocument()
  },
  beforeEach: ({ msw }) => {
    msw.use(workspaceActivityLoadingHandler(), ...workspaceShellHandlers())
  },
  parameters: {
    intent:
      "Catches an activity area that shows a bare Loading text. It shows the activity loading text while the selector is already visible. Not for loaded activity.",
    storyRoute: homeRoute,
  },
})

/**
 * Org home page, where a member asks the agent and opens a Workspace: the user
 * sends a first message from the composer, and the new conversation opens and
 * sends the message.
 */
export const FirstMessageOpensConversation = meta.story({
  tags: ["required"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers())
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a story route with no page, so the screenshot is empty.",
    },
    intent:
      "Catches a first message in the home composer that does not open a new conversation. Sending opens the conversation with the message. Not for the composer layout.",
    storyRoute: homeRoute,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    await waitFor(() =>
      expect(canvas.getByLabelText("Select workspace")).toBeVisible(),
    )
    // The composer mounts again when the workspace list loads, so read the
    // current text box each time, not the first one found.
    const input = await waitFor(
      () => {
        const box = canvas.getByPlaceholderText(
          /what should ctxpipe do in this workspace/i,
        )
        expect(box).toBeEnabled()
        return box
      },
      { timeout: 15_000 },
    )
    await userEvent.type(input, "What changed this week?")
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    await waitFor(() =>
      expect(
        canvas.queryByPlaceholderText(
          /what should ctxpipe do in this workspace/i,
        ),
      ).toBeNull(),
    )
  },
})

/**
 * Org home page, where a member asks the agent and opens a Workspace: the
 * Workspace has no commit history, so the empty commits text shows at once.
 */
export const NoHistory = meta.story({
  tags: ["required"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    await waitFor(() =>
      expect(
        canvas.getByText("No commits on the default branch yet."),
      ).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(
      // The heatmap read has no commits, so Recent needs no list read:
      // the list read hangs, and the empty text shows at once.
      http.get(
        ({ request }) => {
          const url = new URL(request.url)
          return (
            /\/api\/v1\/workspaces\/[^/]+\/activity$/.test(url.pathname) &&
            url.searchParams.has("limit")
          )
        },
        async () => {
          await delay("infinite")
          return HttpResponse.json(emptyWorkspaceActivity)
        },
      ),
      workspaceActivityHandler(emptyWorkspaceActivity),
      ...workspaceShellHandlers(),
    )
  },
  parameters: {
    intent:
      "Catches an org home with no commit history that waits on a hanging list read. The empty commits text shows at once. Not for populated commits.",
    storyRoute: homeRoute,
  },
})
