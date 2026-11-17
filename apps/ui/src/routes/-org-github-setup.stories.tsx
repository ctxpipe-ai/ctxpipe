import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, waitFor, within } from "storybook/test"

import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import {
  githubInstallationLinkedHandler,
  githubInstallationNoneHandler,
  signedInHandlers,
} from "@/mocks/handlers"
import {
  sideNavHandlers,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { GitHubSetupPageContent } from "./$orgSlug.github.setup"

const meta = {
  title: "Pages/Org GitHub setup",
  tags: ["page"],
  render: () => <GitHubSetupPageContent orgSlug="acme" />,
  parameters: {
    app: "org",
    layout: "fullscreen",
    route: "/$orgSlug/github/setup",
    storyRoute: {
      pattern: "flat",
      path: "/acme/github/setup",
      search: "?returnTo=connectors",
    } satisfies StoryRouteParams,
    review: { kind: "page" },
    msw: {
      handlers: {
        session: signedInHandlers,
        ingestion: workspaceIngestionHandlers({}),
        // A story sets `page`. It comes first, so it wins over `shell`.
        page: [],
        // The side nav lists the Workspaces of the org and their chats.
        shell: [...sideNavHandlers()],
      },
    },
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

/**
 * Org GitHub setup page, where the user picks a Workspace for the GitHub App:
 * the installation check is still running, so the page shows its loading state.
 */
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

/**
 * GitHub setup page, which opens after the GitHub App install, where an admin
 * picks a Workspace: the App is not installed, so the page sends the admin back
 * to Connectors.
 */
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

/**
 * GitHub setup page, which opens after the GitHub App install, where an admin
 * picks a Workspace: the check of the install failed, so the page gives the
 * cause and Retry.
 */
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
    // Scope to this alert: the page can hold a second Retry button (seen in CI).
    const alert = canvas
      .getByText("Could not check GitHub")
      .closest("[role=alert]")
    expect(alert).not.toBeNull()
    await waitFor(() =>
      expect(
        within(alert as HTMLElement).getByRole("button", { name: "Retry" }),
      ).toBeVisible(),
    )
  },
}

/**
 * Org GitHub setup page, where the user picks a Workspace for the GitHub App:
 * the App is installed, so the user picks an existing Workspace as the
 * destination.
 */
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
