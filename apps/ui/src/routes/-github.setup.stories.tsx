import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, waitFor, within } from "storybook/test"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import {
  organizationFullWithOrgHandler,
  signedInHandlers,
} from "../mocks/handlers"
import { workspaceListHandler } from "../mocks/workspace-handlers"
import { ConnectGithubView } from "./[.]github.setup"

const meta = {
  title: "Pages/GitHub setup",
  tags: ["page"],
  parameters: {
    msw: { handlers: { session: signedInHandlers } },
    app: "root",
    layout: "fullscreen",
    route: "/.github/setup",
    storyRoute: {
      pattern: "flat",
      path: "/.github/setup",
      search: "?installation_id=42&orgSlug=acme",
    } satisfies StoryRouteParams,
    review: { kind: "page" },
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

/**
 * GitHub setup screen after the App install, which registers the installation:
 * the linked GitHub account cannot access the installation, so the page stops
 * and says why. It does not keep the "Registering installation…" spinner.
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
 * GitHub setup screen after the App install, on a deployment without a GitHub
 * App client: ctxpipe cannot ask GitHub whether the user can access the
 * installation, so the page points to the organization's own App.
 */
export const AuthorizationUnavailableShowsOwnApp: Story = {
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
                  "This deployment cannot confirm GitHub access. Use your organization's own GitHub App",
                why: "github_authorization_unavailable",
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
      name: "Use your organization's own GitHub App",
    })
    await expect(
      canvas.getByRole("link", { name: "Open Connectors" }),
    ).toHaveAttribute("href", "/acme/connectors")
    // The page title stands alone: no "GitHub" eyebrow label above it (DESIGN.md).
    await waitFor(() => {
      expect(canvas.queryByText("Repositories")).not.toBeInTheDocument()
      expect(
        canvas.queryByText("GitHub", { exact: true }),
      ).not.toBeInTheDocument()
    })
  },
}

/**
 * GitHub setup screen after the App install, when the user's linked GitHub
 * account does not show access to the installation: the page names the
 * organization and waits for the user to choose **Authorize on GitHub**. It
 * does not go to GitHub without that click, because another person can send
 * this address.
 */
export const AuthorizationRequiredAsksToConfirm: Story = {
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
                error: "Authorize the GitHub App to confirm your access",
                why: "github_authorization_required",
                authorizeUrl:
                  "https://github.com/login/oauth/authorize?client_id=Iv1.story&state=gh-installation.story",
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
    await canvas.findByRole("heading", { name: "Confirm your GitHub access" })
    await expect(canvas.getByText("acme")).toBeVisible()
    const authorize = canvas.getByRole("link", { name: "Authorize on GitHub" })
    await expect(authorize).toHaveAttribute(
      "href",
      "https://github.com/login/oauth/authorize?client_id=Iv1.story&state=gh-installation.story",
    )
  },
}
