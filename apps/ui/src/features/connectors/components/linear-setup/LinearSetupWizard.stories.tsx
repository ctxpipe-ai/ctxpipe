import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import type { LinearConnectorStatus } from "../../queries/linear-connector"
import { LinearSetupWizard } from "./LinearSetupWizard"

const orgSlug = "acme"
const connectionId = "linear_story"
const baseStatus: LinearConnectorStatus = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme Product",
  isGithubLinked: true,
  selectedScopeCount: 3,
  setupPhase: "awaiting_merge",
  pendingConfigPullUrl: "https://github.com/acme/context/pull/42",
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/context",
    githubConnectionId: "github_1",
    branch: "main",
  },
}

function statusHandler(status: LinearConnectorStatus) {
  return http.get(`/${orgSlug}/api/v1/connectors/linear/status`, () =>
    HttpResponse.json(status),
  )
}

function oauthAppHandler(input: {
  globalLinearOauthConfigured: boolean
  oauthAppSaved: boolean
  oauthClientId?: string | null
}) {
  return http.get(`/${orgSlug}/api/v1/connectors/linear/oauth-app`, () =>
    HttpResponse.json({
      linearOauthConfigured:
        input.globalLinearOauthConfigured || input.oauthAppSaved,
      globalLinearOauthConfigured: input.globalLinearOauthConfigured,
      oauthCallbackUrl: "https://app.example.com/api/v1/integrations/linear/callback",
      linearWebhookUrl: "https://app.example.com/api/v1/webhook/linear",
      linearCreateUrl: "https://linear.app/settings/api/applications/new",
      oauthAppSaved: input.oauthAppSaved,
      oauthClientId: input.oauthClientId ?? null,
    }),
  )
}

function noPullRequestResponseHandlers() {
  const draftStatus: LinearConnectorStatus = {
    ...baseStatus,
    selectedScopeCount: 0,
    setupPhase: "draft",
    pendingConfigPullUrl: null,
  }
  return [
    http.get(`/${orgSlug}/api/v1/connectors/linear/status`, () =>
      HttpResponse.json(draftStatus),
    ),
    http.get(`/${orgSlug}/api/v1/connectors/linear/available-scopes`, () =>
      HttpResponse.json({
        items: [
          {
            externalId: "team-1",
            type: "team",
            title: "Product",
            teamId: "team-1",
            teamKey: "PRO",
          },
        ],
      }),
    ),
    http.get(`/${orgSlug}/api/v1/connectors/linear/config`, () =>
      HttpResponse.json({
        scopes: [],
        syncTarget: {
          ...baseStatus.syncTarget,
          enabled: true,
          setupPhase: "draft",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
        },
      }),
    ),
    http.patch(`/${orgSlug}/api/v1/connectors/linear/config`, async () => {
      await delay(100)
      return HttpResponse.json({
        accepted: true,
        savedCount: 1,
        configPrEnqueued: false,
      })
    }),
  ]
}

const meta = {
  title: "Components/Connections/Linear/SetupWizard",
  component: LinearSetupWizard,
  decorators: entryPageInnerDecorators,
  args: {
    orgSlug,
    connectionId,
    isOpen: true,
    onOpenChange: fn(),
    onConnectionIdChange: fn(),
  },
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof LinearSetupWizard>

export default meta

type Story = StoryObj<typeof meta>

export const ConnectWorkspace: Story = {
  args: { connectionId: undefined },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: true,
            oauthAppSaved: false,
          }),
          statusHandler({
            ...baseStatus,
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
            isGithubLinked: false,
            selectedScopeCount: 0,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            syncTarget: null,
          }),
        ],
      },
    },
  },
}

export const RegisterOauthApp: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: false,
            oauthAppSaved: false,
          }),
          statusHandler({
            ...baseStatus,
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
            isGithubLinked: false,
            selectedScopeCount: 0,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            syncTarget: null,
          }),
        ],
      },
    },
  },
}

export const RegisterOauthAppSaved: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: false,
            oauthAppSaved: true,
            oauthClientId: "lin_client",
          }),
          statusHandler({
            ...baseStatus,
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
            isGithubLinked: false,
            selectedScopeCount: 0,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            syncTarget: null,
          }),
        ],
      },
    },
  },
}

export const AwaitingMerge: Story = {
  parameters: {
    msw: { handlers: { page: [statusHandler(baseStatus)] } },
  },
}

export const SelectRepository: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            selectedScopeCount: 0,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            syncTarget: null,
          }),
          http.get(`/${orgSlug}/api/v1/repositories`, () =>
            HttpResponse.json({ items: [] }),
          ),
          http.get(`/${orgSlug}/api/v1/connectors`, () =>
            HttpResponse.json({
              items: [
                {
                  id: "github_1",
                  type: "github",
                  createdAt: "2026-08-01T00:00:00.000Z",
                  updatedAt: "2026-08-01T00:00:00.000Z",
                },
              ],
            }),
          ),
          http.get(`/${orgSlug}/api/v1/connectors/linear/config`, () =>
            HttpResponse.json({ scopes: [], syncTarget: null }),
          ),
          http.get(`/${orgSlug}/api/v1/connectors/suggested-sync-target`, () =>
            HttpResponse.json({
              target: {
                repositoryId: "repo_ctx",
                repositoryName: "acme/ctxpipe-context",
                gitUrl: "https://github.com/acme/ctxpipe-context.git",
                branch: "main",
                githubConnectionId: "github_1",
                usedBy: ["github"],
              },
            }),
          ),
          http.get(`/${orgSlug}/api/v1/github/installation/repositories`, () =>
            HttpResponse.json({
              repositories: [
                {
                  id: 2,
                  full_name: "acme/ctxpipe-context",
                  html_url: "https://github.com/acme/ctxpipe-context",
                  clone_url: "https://github.com/acme/ctxpipe-context.git",
                  name: "ctxpipe-context",
                  default_branch: "main",
                },
                {
                  id: 1,
                  full_name: "acme/context",
                  html_url: "https://github.com/acme/context",
                  clone_url: "https://github.com/acme/context.git",
                  name: "context",
                  default_branch: "main",
                },
              ],
              repositorySelection: "selected",
              manageUrl: "https://github.com/settings/installations/123",
              hasMore: false,
            }),
          ),
        ],
      },
    },
  },
}

export const SelectScope: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            selectedScopeCount: 0,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
          }),
          http.get(
            `/${orgSlug}/api/v1/connectors/linear/available-scopes`,
            () =>
              HttpResponse.json({
                items: [
                  {
                    externalId: "team-1",
                    type: "team",
                    title: "Product",
                    teamId: "team-1",
                    teamKey: "PRO",
                  },
                  {
                    externalId: "project-1",
                    type: "project",
                    title: "Linear connector",
                    teamId: "team-1",
                    teamKey: "PRO",
                  },
                ],
              }),
          ),
          http.get(`/${orgSlug}/api/v1/connectors/linear/config`, () =>
            HttpResponse.json({
              scopes: [],
              syncTarget: {
                ...baseStatus.syncTarget,
                enabled: true,
                setupPhase: "draft",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
              },
            }),
          ),
        ],
      },
    },
  },
}

export const NoPullRequestResponseClearsProgress: Story = {
  parameters: {
    msw: {
      handlers: {
        page: noPullRequestResponseHandlers(),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByText("Product"))
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Save scope and create pull request",
      }),
    )
    await expect(
      await canvas.findByText("Creating configuration pull request..."),
    ).toBeVisible()
    await expect(
      await canvas.findByText("Configure Linear scope"),
    ).toBeVisible()
    await expect(
      canvas.queryByText("Creating configuration pull request..."),
    ).toBeNull()
  },
}

export const InitialSyncFailed: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            setupPhase: "sync_failed",
            pendingConfigPullUrl: null,
          }),
        ],
      },
    },
  },
}

export const ConfigurationPullRequestFailed: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            setupPhase: "config_failed",
            pendingConfigPullUrl: null,
          }),
        ],
      },
    },
  },
}

export const CreatingPullRequest: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: true,
          }),
        ],
      },
    },
  },
}

export const PullRequestDelayed: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
          }),
        ],
      },
    },
  },
}

export const Complete: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...baseStatus,
            setupPhase: "live",
            pendingConfigPullUrl: null,
          }),
          http.get(`/${orgSlug}/api/v1/connectors/linear/config`, () =>
            HttpResponse.json({
              scopes: [
                {
                  externalId: "team-1",
                  type: "team",
                  title: "Product",
                  teamId: "team-1",
                  teamKey: "PRO",
                },
              ],
              syncTarget: {
                ...baseStatus.syncTarget,
                enabled: true,
                setupPhase: "live",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
              },
            }),
          ),
          http.get(
            `/${orgSlug}/api/v1/connectors/linear/available-scopes`,
            () =>
              HttpResponse.json({
                items: [
                  {
                    externalId: "team-1",
                    type: "team",
                    title: "Product",
                    teamId: "team-1",
                    teamKey: "PRO",
                  },
                ],
              }),
          ),
        ],
      },
    },
  },
}

export const ManageScope: Story = {
  args: {
    manageScope: true,
  },
  parameters: Complete.parameters,
}
