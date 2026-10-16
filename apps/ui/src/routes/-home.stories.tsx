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
    expect(
      await canvas.findByRole(
        "navigation",
        { name: "Main navigation" },
        { timeout: 15_000 },
      ),
    ).toBeVisible()
    expect(canvas.getByLabelText("Select workspace")).toBeVisible()
    expect(canvas.getByText("Loading activity")).toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create Workspace" }),
    ).not.toBeInTheDocument()
  },
  parameters: {
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
    expect(
      await canvas.findByRole(
        "navigation",
        { name: "Main navigation" },
        { timeout: 15_000 },
      ),
    ).toBeVisible()
    expect(await canvas.findByLabelText("Select workspace")).toBeVisible()
    expect(canvas.getByText("Loading activity")).toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create Workspace" }),
    ).not.toBeInTheDocument()
  },
  parameters: {
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
    expect(
      await canvas.findByRole(
        "navigation",
        { name: "Main navigation" },
        { timeout: 15_000 },
      ),
    ).toBeVisible()
    expect(
      await canvas.findByRole("button", { name: "Create Workspace" }),
    ).toBeVisible()
    // The activity of the organization shows, empty.
    await waitFor(() => expect(canvas.getByText("Activity")).toBeVisible())
    await waitFor(() =>
      expect(
        canvas.getByText("No commits on the default branch yet."),
      ).toBeVisible(),
    )
  },
  parameters: {
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: [workspaceListHandler([]), orgActivityHandler()],
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
    expect(
      await canvas.findByRole(
        "navigation",
        { name: "Main navigation" },
        { timeout: 15_000 },
      ),
    ).toBeVisible()
    expect(canvas.getByLabelText("Select workspace")).toBeVisible()
    const activityHeading = await canvas.findByText("Activity")
    expect(activityHeading).toBeVisible()
    expect(activityHeading).toHaveClass("tracking-normal")
    expect(activityHeading).not.toHaveClass("ctx-label")
    expect(canvas.getByText("Recent")).toHaveClass("tracking-normal")
    expect(
      await canvas.findByText("Document billing ledger rules"),
    ).toBeVisible()
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
    expect(
      await canvas.findByRole(
        "navigation",
        { name: "Main navigation" },
        { timeout: 15_000 },
      ),
    ).toBeVisible()
    expect(canvas.getByLabelText("Select workspace")).toBeVisible()
    expect(await canvas.findByText("Loading activity")).toBeInTheDocument()
    expect(canvas.queryByText("Loading…")).not.toBeInTheDocument()
  },
  parameters: {
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
    expect(
      await canvas.findByRole(
        "navigation",
        { name: "Main navigation" },
        { timeout: 15_000 },
      ),
    ).toBeVisible()
    expect(await canvas.findByLabelText("Select workspace")).toBeVisible()
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
    expect(
      await canvas.findByRole(
        "navigation",
        { name: "Main navigation" },
        { timeout: 15_000 },
      ),
    ).toBeVisible()
    expect(
      await canvas.findByText("No commits on the default branch yet."),
    ).toBeVisible()
  },
  parameters: {
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: [
          workspaceActivityHandler(emptyWorkspaceActivity),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
}
