import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { PagerdutySetupDialog } from "./PagerdutySetupDialog"

const orgSlug = "acme"
const connectionId = "con_story_pagerduty"
const saveOauthAppRequest = fn()

const hostedOauth = {
  oauthAppSaved: false,
  globalPagerdutyOAuthConfigured: true,
  oauthCallbackUrl:
    "https://app.example.com/api/v1/integrations/pagerduty/callback",
}

const meta = {
  title: "Components/Connections/PagerdutySetupDialog",
  component: PagerdutySetupDialog,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof PagerdutySetupDialog>

export default meta

type Story = StoryObj<typeof meta>

export const RegisterOAuthApp: Story = {
  render: () => (
    <PagerdutySetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={() => {}}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/pagerduty/status",
              ),
            () =>
              HttpResponse.json({
                isInstalled: false,
                installationStatus: "pending",
                accountName: null,
                accountSubdomain: null,
                region: null,
                isGithubLinked: false,
                selectedServiceCount: null,
                syncTargetConfigured: false,
                setupPhase: "draft",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
                syncTarget: null,
                oauthAppSaved: false,
                globalPagerdutyOAuthConfigured: false,
                oauthCallbackUrl: hostedOauth.oauthCallbackUrl,
              }),
          ),
          http.put(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/pagerduty/oauth-app",
              ),
            async ({ request }) => {
              saveOauthAppRequest(await request.json())
              return new HttpResponse(null, { status: 204 })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByLabelText("Client ID"), "pd-client")
    await userEvent.type(canvas.getByLabelText("Client secret"), "pd-secret")
    await userEvent.click(
      canvas.getByRole("button", { name: "Save OAuth app" }),
    )
    await waitFor(() =>
      expect(saveOauthAppRequest).toHaveBeenCalledWith({
        clientId: "pd-client",
        clientSecret: "pd-secret",
      }),
    )
    await expect(canvas.getByLabelText("Client secret")).toHaveValue("")
  },
}

export const ConnectAccount: Story = {
  render: () => (
    <PagerdutySetupDialog
      orgSlug={orgSlug}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={() => {}}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/pagerduty/oauth/start",
              ),
            () =>
              HttpResponse.json({
                authorizationUrl:
                  "https://identity.pagerduty.com/oauth/authorize",
              }),
          ),
        ],
      },
    },
  },
}

const githubInstallationHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname === `/${orgSlug}/api/v1/github/installation`,
  () =>
    HttpResponse.json({
      id: "con_github",
      appSlug: "ctxpipe-pr-153",
      accountSlug: "acme",
    }),
)

export const ServiceSelection: Story = {
  render: () => (
    <PagerdutySetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      githubConnectionIds={["con_github"]}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={() => {}}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/pagerduty/status",
              ),
            () =>
              HttpResponse.json({
                isInstalled: true,
                installationStatus: "installed",
                accountName: "Acme",
                accountSubdomain: "acme",
                region: "us",
                isGithubLinked: true,
                selectedServiceCount: 0,
                syncTargetConfigured: true,
                setupPhase: "draft",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
                syncTarget: {
                  repositoryId: "repo_1",
                  repositoryName: "acme/context",
                  branch: "main",
                  githubConnectionId: "con_github",
                },
                ...hostedOauth,
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/pagerduty/config",
              ),
            () =>
              HttpResponse.json({
                services: [],
                syncTarget: {
                  repositoryId: "repo_1",
                  repositoryName: "acme/context",
                  branch: "main",
                  githubConnectionId: "con_github",
                  enabled: true,
                  setupPhase: "draft",
                  pendingConfigPullUrl: null,
                  pendingConfigPrCreating: false,
                },
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/pagerduty/available-services",
              ),
            () =>
              HttpResponse.json({
                items: [
                  { id: "PXXXX1", name: "Checkout API" },
                  { id: "PXXXX2", name: "Payments" },
                ],
                more: true,
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                `/${orgSlug}/api/v1/repositories`,
              ),
            () => HttpResponse.json({ items: [] }),
          ),
        ],
      },
    },
  },
}

export const TargetRepository: Story = {
  render: () => (
    <PagerdutySetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      githubConnectionIds={["con_github"]}
      isOpen
      onOpenChange={() => {}}
      onConnectionIdChange={() => {}}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          githubInstallationHandler,
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/pagerduty/status",
              ),
            () =>
              HttpResponse.json({
                isInstalled: true,
                installationStatus: "installed",
                accountName: "Acme",
                accountSubdomain: "acme",
                region: "us",
                isGithubLinked: true,
                selectedServiceCount: 0,
                syncTargetConfigured: false,
                setupPhase: "draft",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
                syncTarget: null,
                ...hostedOauth,
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/pagerduty/config",
              ),
            () => HttpResponse.json({ services: [], syncTarget: null }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname ===
              `/${orgSlug}/api/v1/repositories`,
            () =>
              HttpResponse.json({
                items: [
                  {
                    id: "repo_context",
                    name: "acme/context",
                    gitUrl: "https://github.com/acme/context.git",
                  },
                ],
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/connectors/suggested-sync-target",
              ),
            () =>
              HttpResponse.json({
                target: {
                  repositoryId: "repo_context",
                  repositoryName: "acme/context",
                  gitUrl: "https://github.com/acme/context.git",
                  branch: "main",
                  githubConnectionId: "con_github",
                  usedBy: ["confluence"],
                },
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/github/installation/repositories",
              ),
            () =>
              HttpResponse.json({
                repositories: [
                  {
                    id: 100,
                    full_name: "acme/context",
                    html_url: "https://github.com/acme/context",
                    clone_url: "https://github.com/acme/context.git",
                    name: "context",
                    default_branch: "main",
                  },
                  {
                    id: 101,
                    full_name: "acme/incidents",
                    html_url: "https://github.com/acme/incidents",
                    clone_url: "https://github.com/acme/incidents.git",
                    name: "incidents",
                    default_branch: "main",
                  },
                ],
                repositorySelection: "selected",
                manageUrl:
                  "https://github.com/organizations/acme/settings/installations/123",
                hasMore: false,
              }),
          ),
        ],
      },
    },
  },
}
