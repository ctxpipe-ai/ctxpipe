import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { emptyWorkspaceActivity } from "@/features/workspaces/workspace-fixtures"
import {
  authConfigHandler,
  organizationListWithOrgHandler,
} from "@/mocks/handlers"
import {
  orgActivityHandler,
  workspaceActivityHandler,
  workspaceActivityLoadingHandler,
  workspaceListHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"

import { orgPageDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OrgHomePageContent } from "./$orgSlug.index"

const meta = {
  title: "Pages/Home",
  decorators: orgPageDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

const homeRoute = {
  pattern: "orgIndex",
  orgSlug: "acme",
} satisfies StoryRouteParams

export const Loading: Story = {
  tags: ["workspace-golden"],
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
  parameters: {
    intent:
      "Catches an org home that shows content or a Create button while the session loads. The shell shows the selector and the activity loading text. Not for loaded data.",
    storyRoute: homeRoute,
    msw: {
      handlers: {
        // Replaces the preview's signed-in user so the session request hangs.
        defaults: [
          authConfigHandler,
          http.get("*/.auth/api/v1/auth/get-session", async () => {
            await delay("infinite")
            return HttpResponse.json(null)
          }),
          organizationListWithOrgHandler,
        ],
        page: [workspaceListHandler([])],
      },
    },
  },
}

/** The workspace list is still loading: the composer and activity skeleton hold their place. */
export const WorkspacesLoading: Story = {
  tags: ["workspace-golden"],
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
  parameters: {
    intent:
      "Catches an org home that shows a Create button while workspaces load. It shows the selector and the activity loading text. Not for loaded workspaces or errors.",
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
            async () => {
              await delay("infinite")
              return HttpResponse.json({ items: [], lastUsedWorkspaceId: null })
            },
          ),
        ],
      },
    },
  },
}

/**
 * No Workspace, and the user dismissed the guide: the Create Workspace
 * button, then the empty activity.
 */
export const Empty: Story = {
  tags: ["workspace-golden"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  beforeEach: () => {
    window.localStorage.setItem(
      "ctxpipe:userPreferences",
      JSON.stringify({
        orgGuides: {
          "user_storybook:acme": { dismissedAt: "2026-01-01T00:00:00.000Z" },
        },
      }),
    )
    return () => window.localStorage.removeItem("ctxpipe:userPreferences")
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
    msw: {
      handlers: {
        page: [workspaceListHandler([]), orgActivityHandler()],
      },
    },
  },
}

let listReadFails = true

/**
 * The Workspace list read fails: Home shows an error with a Retry. It does
 * not show the Create Workspace button or the setup guide, which would say
 * the organization has no Workspace.
 */
export const WorkspacesLoadFails: Story = {
  tags: ["workspace-golden"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  beforeEach: () => {
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
  },
  parameters: {
    intent:
      "Catches a failed workspace list that shows the guide or a Create button. It shows an alert with Retry, and Retry loads the home again. Not for loaded lists.",
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
            () =>
              listReadFails
                ? HttpResponse.json({ error: "boom" }, { status: 500 })
                : HttpResponse.json({ items: [], lastUsedWorkspaceId: null }),
          ),
          orgActivityHandler(),
        ],
      },
    },
  },
}

/**
 * No Workspace, so no commits: Recent shows the empty text at once, while
 * the heatmap still loads. It shows no commit rows that then go away.
 */
export const EmptyRecentWhileActivityLoads: Story = {
  tags: ["workspace-golden"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  beforeEach: Empty.beforeEach,
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
    msw: {
      handlers: {
        page: [
          workspaceListHandler([]),
          http.get(
            ({ request }) =>
              /\/api\/v1\/activity$/.test(new URL(request.url).pathname),
            async () => {
              await delay("infinite")
              return HttpResponse.json(emptyWorkspaceActivity)
            },
          ),
        ],
      },
    },
  },
}

export const Populated: Story = {
  tags: ["workspace-golden"],
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
  parameters: {
    intent:
      "Catches an org home that shows wrong headings or no commits. It shows the selector, Activity and Recent headings in the plain style, and recent commits. Not for loading states.",
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

/**
 * Activity and Recent have the same 40 px gap as the other Home blocks. The
 * view-transition wrapper around them must not remove it.
 */
export const ActivityAndRecentKeepTheirGap: Story = {
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
  parameters: {
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const ActivityLoading: Story = {
  tags: ["workspace-golden"],
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
  parameters: {
    intent:
      "Catches an activity area that shows a bare Loading text. It shows the activity loading text while the selector is already visible. Not for loaded activity.",
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: [workspaceActivityLoadingHandler(), ...workspaceShellHandlers()],
      },
    },
  },
}

/** The composer opens the new conversation, which sends the message. */
export const FirstMessageOpensConversation: Story = {
  tags: ["workspace-golden"],
  render: () => <OrgHomePageContent orgSlug="acme" />,
  parameters: {
    intent:
      "Catches a first message in the home composer that does not open a new conversation. Sending opens the conversation with the message. Not for the composer layout.",
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: [...workspaceShellHandlers()],
      },
    },
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
}

export const NoHistory: Story = {
  tags: ["workspace-golden"],
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
  parameters: {
    intent:
      "Catches an org home with no commit history that waits on a hanging list read. The empty commits text shows at once. Not for populated commits.",
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: [
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
        ],
      },
    },
  },
}
