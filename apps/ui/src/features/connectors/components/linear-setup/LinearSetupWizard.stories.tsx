import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { fn } from "storybook/test"
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
          http.get(`/${orgSlug}/api/v1/github/installation/repositories`, () =>
            HttpResponse.json({
              repositories: [
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
