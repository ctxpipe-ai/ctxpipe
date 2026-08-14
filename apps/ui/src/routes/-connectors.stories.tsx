import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { ConnectorsPageContent } from "./$orgSlug.connectors"

const orgSlug = "acme"

const meta = {
  title: "Pages/Connections",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Empty: Story = {
  render: () => <ConnectorsPageContent orgSlug={orgSlug} />,
  parameters: {
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const p = new URL(request.url).pathname
              return p === `/${orgSlug}/api/v1/connectors`
            },
            () => HttpResponse.json({ items: [] }),
          ),
        ],
      },
    },
  },
}

export const Loading: Story = {
  render: () => <ConnectorsPageContent orgSlug={orgSlug} />,
  parameters: {
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const p = new URL(request.url).pathname
              return p === `/${orgSlug}/api/v1/connectors`
            },
            async () => {
              await delay("infinite")
              return HttpResponse.json({ items: [] })
            },
          ),
        ],
      },
    },
  },
}

const forgeId = "conn_forge_1"
const githubId = "conn_github_1"
const slackId = "conn_slack_1"
const linearId = "conn_linear_1"
const notionId = "conn_notion_1"

const connectionItems = [
  {
    id: githubId,
    type: "github" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: forgeId,
    type: "forge" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: slackId,
    type: "slack" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: linearId,
    type: "linear" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: notionId,
    type: "notion" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
]

const orgAtlassianOauthHandler = http.get(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname === `/${orgSlug}/api/v1/org/atlassian-oauth` &&
      u.searchParams.get("connectionId") === forgeId
    )
  },
  ({ request }) =>
    HttpResponse.json({
      oauthAppSaved: true,
      atlassianOAuthClientId: "story-client",
      globalAtlassianOAuthConfigured: false,
      oauthCallbackUrl: `${new URL(request.url).origin}/api/v1/integrations/atlassian/callback`,
      atlassianCreateUrl:
        "https://developer.atlassian.com/cloud/oauth-2-3lo-apps",
    }),
)

const atlassianStatusComplete = {
  isLinked: true,
  isInstalled: true,
  installationStatus: "installed",
  isGithubLinked: true,
  selectedSpaceCount: 1,
  syncTargetConfigured: true,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/ingest",
    branch: "main",
  },
  selectedSpaces: [{ spaceKey: "ENG", spaceName: "Engineering" }],
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
}

const notionStatusComplete = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme",
  isGithubLinked: true,
  selectedResourceCount: 2,
  syncTargetConfigured: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/ingest",
    branch: "main",
  },
}

const linearStatusComplete = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme Product",
  isGithubLinked: true,
  selectedScopeCount: 4,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/ingest",
    githubConnectionId: githubId,
    branch: "main",
  },
}

const slackStatusComplete = {
  isInstalled: true,
  installationStatus: "installed",
  teamName: "Acme Workspace",
  isGithubLinked: true,
  setupPhase: "live",
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/ctxpipe-context",
    branch: "main",
    githubConnectionId: githubId,
  },
}

const githubInstallationComplete = {
  id: githubId,
  installationId: 12345,
  accountSlug: "acme-corp",
  ingestionRepositoryCount: 3,
}

function connectorsListHandler() {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname === `/${orgSlug}/api/v1/connectors`,
    () => HttpResponse.json({ items: connectionItems }),
  )
}

function atlassianStatusHandler(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname.endsWith("/api/v1/connectors/atlassian/status") &&
        u.searchParams.get("connectionId") === forgeId
      )
    },
    () => HttpResponse.json(status),
  )
}

function notionStatusHandler(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname.endsWith("/api/v1/connectors/notion/status") &&
        u.searchParams.get("connectionId") === notionId
      )
    },
    () => HttpResponse.json(status),
  )
}

function linearStatusHandler(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname.endsWith("/api/v1/connectors/linear/status") &&
        u.searchParams.get("connectionId") === linearId
      )
    },
    () => HttpResponse.json(status),
  )
}

function slackStatusHandler(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname.includes("/api/v1/connectors/slack/status") &&
        u.searchParams.get("connectionId") === slackId
      )
    },
    () => HttpResponse.json(status),
  )
}

function githubInstallationHandler(body: object | null) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname.includes("/api/v1/github/installation") &&
        u.searchParams.get("connectionId") === githubId
      )
    },
    () => HttpResponse.json(body),
  )
}

function statusFailed(pathnameSuffix: string, connectionId: string) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname.endsWith(pathnameSuffix) &&
        u.searchParams.get("connectionId") === connectionId
      )
    },
    () => new HttpResponse(null, { status: 500 }),
  )
}

function pageHandlers(handlers: ReturnType<typeof http.get>[]) {
  return {
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: { handlers: { page: handlers } },
  }
}

const pageRender = () => <ConnectorsPageContent orgSlug={orgSlug} />

export const Full: Story = {
  render: pageRender,
  parameters: pageHandlers([
    connectorsListHandler(),
    atlassianStatusHandler(atlassianStatusComplete),
    orgAtlassianOauthHandler,
    notionStatusHandler(notionStatusComplete),
    githubInstallationHandler(githubInstallationComplete),
    linearStatusHandler(linearStatusComplete),
    slackStatusHandler(slackStatusComplete),
  ]),
}

export const InProgress: Story = {
  render: pageRender,
  parameters: pageHandlers([
    connectorsListHandler(),
    githubInstallationHandler(null),
    orgAtlassianOauthHandler,
    atlassianStatusHandler({
      isLinked: true,
      isInstalled: true,
      installationStatus: "installed",
      isGithubLinked: false,
      selectedSpaceCount: 0,
      syncTargetConfigured: false,
      syncTarget: null,
      selectedSpaces: [],
    }),
    linearStatusHandler({
      isInstalled: false,
      installationStatus: null,
      workspaceName: null,
      isGithubLinked: false,
      selectedScopeCount: 0,
      setupPhase: "draft",
      pendingConfigPullUrl: null,
      pendingConfigPrCreating: false,
      syncTarget: null,
    }),
    notionStatusHandler({
      isInstalled: true,
      installationStatus: "installed",
      workspaceName: "Acme",
      isGithubLinked: true,
      selectedResourceCount: 2,
      syncTargetConfigured: true,
      setupPhase: "awaiting_merge",
      pendingConfigPullUrl: "https://github.com/acme/ingest/pull/42",
      pendingConfigPrCreating: false,
      syncTarget: notionStatusComplete.syncTarget,
    }),
    slackStatusHandler({
      ...slackStatusComplete,
      isGithubLinked: false,
      setupPhase: "draft",
      syncTarget: null,
    }),
  ]),
}

export const MixedHealth: Story = {
  render: pageRender,
  parameters: pageHandlers([
    connectorsListHandler(),
    githubInstallationHandler(githubInstallationComplete),
    orgAtlassianOauthHandler,
    atlassianStatusHandler({
      isLinked: false,
      isInstalled: false,
      installationStatus: null,
      isGithubLinked: false,
      selectedSpaceCount: 0,
      syncTargetConfigured: false,
      syncTarget: null,
      selectedSpaces: [],
    }),
    linearStatusHandler({
      ...linearStatusComplete,
      setupPhase: "sync_failed",
    }),
    notionStatusHandler({
      ...notionStatusComplete,
      setupPhase: "config_failed",
    }),
    slackStatusHandler(slackStatusComplete),
  ]),
}

export const CouldntLoad: Story = {
  render: pageRender,
  parameters: pageHandlers([
    connectorsListHandler(),
    orgAtlassianOauthHandler,
    statusFailed("/api/v1/github/installation", githubId),
    statusFailed("/api/v1/connectors/atlassian/status", forgeId),
    statusFailed("/api/v1/connectors/linear/status", linearId),
    statusFailed("/api/v1/connectors/notion/status", notionId),
    statusFailed("/api/v1/connectors/slack/status", slackId),
  ]),
}
