import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, within } from "storybook/test"
import {
  workspaceActivityHandler,
  workspaceActivityLoadingHandler,
  workspaceListHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"
import { orgPageDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { emptyWorkspaceActivity } from "@/features/workspaces/workspace-fixtures"
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
    expect(canvas.getByText("Loading home")).toBeInTheDocument()
  },
  parameters: {
    storyRoute: homeRoute,
    msw: {
      handlers: {
        page: [
          http.get("*/.auth/api/v1/auth/get-session", async () => {
            await delay("infinite")
            return HttpResponse.json(null)
          }),
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
      canvas.getByRole("button", { name: "Create a workspace" }),
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
    expect(await canvas.findByText("Activity")).toBeVisible()
    expect(canvas.getByText("Document billing ledger rules")).toBeVisible()
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
        page: [
          workspaceActivityLoadingHandler(),
          ...workspaceShellHandlers(),
        ],
      },
    },
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
