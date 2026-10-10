import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { emptyWorkspaceActivity } from "@/features/workspaces/workspace-fixtures"
import {
  authConfigHandler,
  organizationListWithOrgHandler,
} from "@/mocks/handlers"
import {
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
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    expect(canvas.getByLabelText("Select workspace")).toBeVisible()
    expect(canvas.getByText("Loading activity")).toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create a workspace" }),
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
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    expect(await canvas.findByLabelText("Select workspace")).toBeVisible()
    expect(canvas.getByText("Loading activity")).toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create a workspace" }),
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

export const Empty: Story = {
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    expect(
      await canvas.findByRole("button", { name: "Create a workspace" }),
    ).toBeVisible()
    expect(canvas.queryByText("Activity")).not.toBeInTheDocument()
  },
  parameters: {
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: [workspaceListHandler([])],
      },
    },
  },
}

export const Populated: Story = {
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
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
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
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
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    expect(await canvas.findByLabelText("Select workspace")).toBeVisible()
    const input = await canvas.findByPlaceholderText(/ask about this workspace/i)
    await waitFor(() => expect(input).toBeEnabled())
    await userEvent.type(input, "What changed this week?")
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    await waitFor(() =>
      expect(
        canvas.queryByPlaceholderText(/ask about this workspace/i),
      ).toBeNull(),
    )
  },
}

export const NoHistory: Story = {
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
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
