import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, waitFor, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import {
  organizationFullWithOrgHandler,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
} from "../mocks/handlers"
import { workspaceListHandler } from "../mocks/workspace-handlers"
import { ConnectGithubView } from "./[.]github.setup"

const meta = {
  title: "Pages/GitHub setup",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "flat",
      path: "/.github/setup",
      search: "?installation_id=42&orgSlug=acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

/**
 * The linked GitHub account cannot see the installation. The page must stop
 * and say why, not keep the "Registering installation…" spinner.
 */
export const RegistrationRefused: Story = {
  render: () => (
    <ConnectGithubView installationId={42} selectedOrganizationSlug="acme" />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          organizationFullWithOrgHandler,
          workspaceListHandler([]),
          http.post("*/acme/api/v1/github/installation", () =>
            HttpResponse.json(
              {
                error:
                  "Your GitHub account cannot access this GitHub App installation",
                message:
                  "Your GitHub account cannot access this GitHub App installation",
                why: "github_installation_not_accessible",
              },
              { status: 403 },
            ),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const alert = await canvas.findByRole("alert")
    await waitFor(() =>
      expect(alert).toHaveTextContent(
        "Your GitHub account cannot access this GitHub App installation",
      ),
    )
    await expect(
      canvas.queryByText("Registering installation…"),
    ).not.toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: "Open Connectors" }),
    ).toBeVisible()
  },
}

/**
 * The user came back from a failed GitHub account link. The page says why,
 * in GitHub terms, and still offers the link.
 */
export const NotLinkedShowsLinkError: Story = {
  render: () => (
    <ConnectGithubView
      installationId={42}
      selectedOrganizationSlug="acme"
      linkError="account_already_linked_to_different_user"
    />
  ),
  parameters: {
    msw: {
      handlers: {
        // Replaces the preview's config, which has no social providers.
        defaults: [
          http.get("*/.auth/api/config", () =>
            HttpResponse.json({ providers: ["github"] }),
          ),
          sessionSignedInHandler({
            id: "user_storybook",
            onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
          }),
          organizationListWithOrgHandler,
        ],
        page: [
          organizationFullWithOrgHandler,
          workspaceListHandler([]),
          http.post("*/acme/api/v1/github/installation", () =>
            HttpResponse.json(
              {
                error: "Connect your GitHub account to link this installation",
                why: "github_not_linked",
              },
              { status: 403 },
            ),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", {
      name: "Connect your GitHub account to finish setup",
    })
    const alert = await canvas.findByRole("alert")
    await waitFor(() =>
      expect(alert).toHaveTextContent(
        /This GitHub account is linked to another ctx\| user/,
      ),
    )
    await expect(canvas.queryByText("Repositories")).not.toBeInTheDocument()
    await waitFor(() =>
      expect(canvas.getByText("GitHub", { exact: true })).toBeVisible(),
    )
  },
}
