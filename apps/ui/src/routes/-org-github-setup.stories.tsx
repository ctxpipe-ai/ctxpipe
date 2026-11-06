import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, waitFor, within } from "storybook/test"

import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import {
  githubInstallationLinkedHandler,
  githubInstallationNoneHandler,
} from "@/mocks/handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"

import { orgPageDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { GitHubSetupPageContent } from "./$orgSlug.github.setup"

const meta = {
  title: "Pages/Org GitHub setup",
  tags: ["page"],
  decorators: orgPageDecorators,
  render: () => <GitHubSetupPageContent orgSlug="acme" />,
  parameters: {
    layout: "fullscreen",
    route: "/$orgSlug/github/setup",
    storyRoute: {
      pattern: "flat",
      path: "/acme/github/setup",
      search: "?returnTo=connectors",
    } satisfies StoryRouteParams,
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

/** The installation check is still running. */
export const Checking: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/github\/installation$/.test(
                new URL(request.url).pathname,
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json(null)
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText("Checking GitHub connection"),
      ).toBeInTheDocument(),
    )
  },
}

/** The GitHub App is not installed: the page sends the user back to Connectors. */
export const NotInstalled: Story = {
  parameters: {
    msw: { handlers: { page: [githubInstallationNoneHandler] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Finish connecting GitHub" }),
      ).toBeVisible(),
    )
  },
}

/** The check fails: the page offers a retry. */
export const CheckFails: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/github\/installation$/.test(
                new URL(request.url).pathname,
              ),
            () => HttpResponse.json({ error: "boom" }, { status: 500 }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Could not check GitHub")).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible(),
    )
  },
}

/** The App is installed: the user picks a Workspace destination. */
export const ChooseWorkspace: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          githubInstallationLinkedHandler,
          workspaceListHandler([docsWorkspace]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("list", { name: "Existing workspaces" }),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Close wizard" }),
      ).toBeVisible(),
    )
  },
}
