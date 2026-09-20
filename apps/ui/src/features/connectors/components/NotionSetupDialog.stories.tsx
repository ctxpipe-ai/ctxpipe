import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { NotionSetupDialog } from "./NotionSetupDialog"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const meta = {
  title: "Components/Connections/NotionSetupDialog",
  component: NotionSetupDialog,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof NotionSetupDialog>

export default meta

type Story = StoryObj<typeof meta>

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

function notionOauthAppHandler(body: {
  oauthAppSaved?: boolean
  globalNotionOAuthConfigured?: boolean
  oauthClientId?: string | null
  webhookUrl?: string
} = {}) {
  const oauthAppSaved = body.oauthAppSaved ?? false
  const globalNotionOAuthConfigured = body.globalNotionOAuthConfigured ?? true
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname === `/${orgSlug}/api/v1/connectors/notion/oauth-app` &&
        u.searchParams.get("connectionId") === connectionId
      )
    },
    ({ request }) => {
      const origin = new URL(request.url).origin
      return HttpResponse.json({
        oauthConfigured: oauthAppSaved || globalNotionOAuthConfigured,
        oauthAppSaved,
        oauthClientId: body.oauthClientId ?? (oauthAppSaved ? "notion-client-id" : null),
        webhookConfigured: oauthAppSaved || globalNotionOAuthConfigured,
        globalNotionOAuthConfigured,
        callbackUrl: `${origin}/api/v1/connectors/notion/oauth/callback`,
        webhookUrl:
          body.webhookUrl ??
          (oauthAppSaved
            ? `${origin}/api/v1/webhook/notion?connectionId=${connectionId}&provisioningToken=story`
            : `${origin}/api/v1/webhook/notion`),
      })
    },
  )
}

const notionOauthAppPut = http.put(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname === `/${orgSlug}/api/v1/connectors/notion/oauth-app` &&
      u.searchParams.get("connectionId") === connectionId
    )
  },
  () => new HttpResponse(null, { status: 204 }),
)

const draftStatus = {
  isInstalled: false,
  installationStatus: null,
  workspaceName: null,
  isGithubLinked: false,
  selectedResourceCount: 0,
  syncTargetConfigured: false,
  setupPhase: "draft",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: null,
}

function notionStatus(status: object) {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname.includes("/api/v1/connectors/notion/status"),
    () => HttpResponse.json(status),
  )
}

function dialog() {
  return (
    <NotionSetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      githubConnectionIds={["con_github"]}
      isOpen
      onOpenChange={() => {}}
    />
  )
}

export const RegisterNotionOauth: Story = {
  name: "Register Notion integration (self-hosted)",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
          notionStatus(draftStatus),
          (() => {
            let saved = false
            let clientId: string | null = null
            return [
              http.get(
                ({ request }) => {
                  const u = new URL(request.url)
                  return (
                    u.pathname ===
                      `/${orgSlug}/api/v1/connectors/notion/oauth-app` &&
                    u.searchParams.get("connectionId") === connectionId
                  )
                },
                ({ request }) => {
                  const origin = new URL(request.url).origin
                  return HttpResponse.json({
                    oauthConfigured: saved,
                    oauthAppSaved: saved,
                    oauthClientId: clientId,
                    webhookConfigured: saved,
                    globalNotionOAuthConfigured: false,
                    callbackUrl: `${origin}/api/v1/connectors/notion/oauth/callback`,
                    webhookUrl: saved
                      ? `${origin}/api/v1/webhook/notion?connectionId=${connectionId}&provisioningToken=story`
                      : `${origin}/api/v1/webhook/notion`,
                  })
                },
              ),
              http.put(
                ({ request }) => {
                  const u = new URL(request.url)
                  return (
                    u.pathname ===
                      `/${orgSlug}/api/v1/connectors/notion/oauth-app` &&
                    u.searchParams.get("connectionId") === connectionId
                  )
                },
                async ({ request }) => {
                  const body = (await request.json()) as {
                    clientId?: string
                  }
                  saved = true
                  clientId = body.clientId ?? "notion-client-id"
                  return new HttpResponse(null, { status: 204 })
                },
              ),
            ]
          })(),
        ].flat(),
      },
    },
  },
}

export const RegisterNotionOauthSaved: Story = {
  name: "Register Notion integration (saved — Event URL)",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
          notionStatus(draftStatus),
          notionOauthAppHandler({
            oauthAppSaved: true,
            globalNotionOAuthConfigured: false,
            oauthClientId: "notion-client-id-story",
          }),
          notionOauthAppPut,
        ],
      },
    },
  },
}

export const ConnectNotionGlobalEnv: Story = {
  name: "Connect Notion (hosted env OAuth)",
  render: () => dialog(),
  parameters: {
    msw: {
      handlers: {
        page: [
          notionStatus(draftStatus),
          notionOauthAppHandler({
            oauthAppSaved: false,
            globalNotionOAuthConfigured: true,
          }),
        ],
      },
    },
  },
}

export const ResourceSelection: Story = {
  render: () => (
    <NotionSetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      githubConnectionIds={["con_github"]}
      isOpen
      onOpenChange={() => {}}
    />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/status",
              ),
            () =>
              HttpResponse.json({
                isInstalled: true,
                installationStatus: "installed",
                workspaceName: "Acme",
                isGithubLinked: true,
                selectedResourceCount: 0,
                syncTargetConfigured: true,
                setupPhase: "live",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
                syncTarget: {
                  repositoryId: "repo_1",
                  repositoryName: "acme/context",
                  branch: "main",
                  githubConnectionId: "con_github",
                },
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/config",
              ),
            () =>
              HttpResponse.json({
                resources: [],
                syncTarget: {
                  id: connectionId,
                  orgId: "org_1",
                  connectionId,
                  repositoryId: "repo_1",
                  repositoryName: "acme/context",
                  branch: "main",
                  githubConnectionId: "con_github",
                  enabled: true,
                  setupPhase: "live",
                  pendingConfigPullUrl: null,
                  pendingConfigPrCreating: false,
                  createdAt: "2025-01-01T00:00:00.000Z",
                  updatedAt: "2025-01-01T00:00:00.000Z",
                },
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/available-resources",
              ),
            () =>
              HttpResponse.json({
                items: [
                  {
                    externalId: "page_1",
                    type: "page",
                    title: "Product decisions",
                    url: "https://notion.so/page_1",
                    parentExternalId: null,
                  },
                  {
                    externalId: "page_2",
                    type: "page",
                    title: "Feature scoping",
                    url: "https://notion.so/page_2",
                    parentExternalId: null,
                  },
                ],
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                `/${orgSlug}/api/v1/repositories`,
              ),
            () => HttpResponse.json({ items: [] }),
          ),
          notionOauthAppHandler(),
        ],
      },
    },
  },
}

export const TargetRepository: Story = {
  render: () => (
    <NotionSetupDialog
      orgSlug={orgSlug}
      connectionId={connectionId}
      githubConnectionIds={["con_github"]}
      isOpen
      onOpenChange={() => {}}
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
                "/api/v1/connectors/notion/status",
              ),
            () =>
              HttpResponse.json({
                isInstalled: true,
                installationStatus: "installed",
                workspaceName: "Acme",
                isGithubLinked: true,
                selectedResourceCount: 0,
                syncTargetConfigured: false,
                setupPhase: "draft",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
                syncTarget: null,
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/config",
              ),
            () => HttpResponse.json({ resources: [], syncTarget: null }),
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
                    full_name: "acme/notion-target",
                    html_url: "https://github.com/acme/notion-target",
                    clone_url: "https://github.com/acme/notion-target.git",
                    name: "notion-target",
                    default_branch: "main",
                  },
                ],
                repositorySelection: "selected",
                manageUrl:
                  "https://github.com/organizations/acme/settings/installations/123",
                hasMore: false,
              }),
          ),
          notionOauthAppHandler(),
        ],
      },
    },
  },
}
