import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, waitFor, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { organizationFullWithOrgHandler } from "../mocks/handlers"
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
