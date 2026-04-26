import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import type { AtlassianConnectorStatus } from "../../types"
import { ConfluenceSetupWizard } from "./ConfluenceSetupWizard"

const orgSlug = "acme"
const atlassianConnectionId = "conn_forge_wizard"

function statusUrlMatches(request: Request, connectionId: string) {
  const u = new URL(request.url)
  if (!u.pathname.includes("/api/v1/connectors/atlassian/status")) {
    return false
  }
  return u.searchParams.get("connectionId") === connectionId
}

const status = (s: AtlassianConnectorStatus) =>
  http.get(
    ({ request }) => statusUrlMatches(request, atlassianConnectionId),
    () => HttpResponse.json(s),
  )

/** For stories where the wizard is rendered *without* `connectionId` (no query param on the wire). */
const statusUnscoped = (s: AtlassianConnectorStatus) =>
  http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/atlassian/status")) {
        return false
      }
      return u.searchParams.get("connectionId") == null
    },
    () => HttpResponse.json(s),
  )

function orgAtlassianOauthGet(
  oauthAppSaved: boolean,
  globalAtlassianOAuthConfigured = false,
) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname === `/${orgSlug}/api/v1/org/atlassian-oauth` &&
        u.searchParams.get("connectionId") === atlassianConnectionId
      )
    },
    () =>
      HttpResponse.json({
        oauthAppSaved,
        atlassianOAuthClientId: oauthAppSaved
          ? "atlassian-oauth-client-id-story"
          : null,
        globalAtlassianOAuthConfigured,
        oauthCallbackUrl:
          "https://app.example.com/api/v1/integrations/atlassian/callback",
        atlassianCreateUrl:
          "https://developer.atlassian.com/cloud/oauth-2-3lo-apps",
      }),
  )
}

const orgAtlassianOauthPut = http.put(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname === `/${orgSlug}/api/v1/org/atlassian-oauth` &&
      u.searchParams.get("connectionId") === atlassianConnectionId
    )
  },
  () => new HttpResponse(null, { status: 204 }),
)

const capabilitiesHosted = http.get(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname === `/${orgSlug}/api/v1/capabilities` &&
      u.searchParams.get("connectionId") === atlassianConnectionId
    )
  },
  () =>
    HttpResponse.json({
      confluenceForgeInstallUrl:
        "https://marketplace.atlassian.com/apps/123/ctxpipe",
    }),
)

const installationPost = http.post(
  ({ request }) => {
    const u = new URL(request.url)
    return u.pathname === `/${orgSlug}/api/v1/connectors/atlassian/installation`
  },
  () => HttpResponse.json({ id: "install_intent_story" }),
)

function configGetPredicate(request: Request) {
  const u = new URL(request.url)
  if (!u.pathname.includes("/atlassian/config")) return false
  return u.searchParams.get("connectionId") === atlassianConnectionId
}

const scopeConfigBody = {
  spaces: [
    {
      id: "scope_row_1",
      connectionId: atlassianConnectionId,
      spaceKey: "DOC",
      spaceName: "Documentation",
      selectedPageIds: null as string[] | null,
      lastSyncedPageId: null as string | null,
      lastSyncedAt: null as string | null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  ],
  syncTarget: {
    id: "st1",
    orgId: "org_story",
    connectionId: atlassianConnectionId,
    repositoryId: "repo1",
    repositoryName: "acme/ingest",
    branch: "main",
    enabled: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
}

const availableSpaces = {
  items: [{ id: "s1", key: "DOC", name: "Documentation", type: "global" }],
}

const scopeHandlers = [
  http.get(
    ({ request }) => configGetPredicate(request),
    () => HttpResponse.json(scopeConfigBody),
  ),
  http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/atlassian/available-spaces")) return false
      if (u.searchParams.get("connectionId") !== atlassianConnectionId) {
        return false
      }
      return u.pathname.endsWith("/available-spaces")
    },
    () => HttpResponse.json(availableSpaces),
  ),
  http.patch(
    ({ request }) => configGetPredicate(request),
    () =>
      HttpResponse.json({
        accepted: true,
        savedCount: 1,
        syncEnqueued: false,
      }),
  ),
]

const searchPayload = {
  repositories: [
    {
      id: 101,
      full_name: "acme/confluence-target",
      html_url: "https://github.com/acme/confluence-target",
      clone_url: "https://github.com/acme/confluence-target.git",
      name: "confluence-target",
      default_branch: "main",
    },
  ],
  repositorySelection: "selected",
  hasMore: false,
}

const syncTargetHandlers = [
  http.get(
    ({ request }) =>
      new URL(request.url).pathname === `/${orgSlug}/api/v1/repositories`,
    () =>
      HttpResponse.json({
        items: [
          {
            id: "repo_101",
            name: "confluence-target",
            gitUrl: "https://github.com/acme/confluence-target.git",
          },
        ],
      }),
  ),
  http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/atlassian/config")) return false
      return u.searchParams.get("connectionId") === atlassianConnectionId
    },
    () => new HttpResponse(null, { status: 409 }),
  ),
  http.get(
    ({ request }) =>
      new URL(request.url).pathname.includes("installation/repositories"),
    () => HttpResponse.json(searchPayload),
  ),
  http.patch(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/atlassian/config")) return false
      return u.searchParams.get("connectionId") === atlassianConnectionId
    },
    () =>
      HttpResponse.json({
        accepted: true,
        savedCount: 1,
        syncEnqueued: false,
      }),
  ),
]

const s0: AtlassianConnectorStatus = {
  isLinked: false,
  isInstalled: false,
  installationStatus: null,
  isGithubLinked: false,
  selectedSpaceCount: 0,
  syncTargetConfigured: false,
  syncTarget: null,
  selectedSpaces: [],
}

const sInstall: AtlassianConnectorStatus = {
  ...s0,
  isLinked: true,
  isInstalled: false,
  installationStatus: null,
}

const sAfterGithub: AtlassianConnectorStatus = {
  ...sInstall,
  isInstalled: true,
  installationStatus: "installed",
  isGithubLinked: true,
  syncTargetConfigured: true,
  syncTarget: {
    repositoryId: "r1",
    repositoryName: "acme/wiki",
    branch: "main",
  },
}

const sNeedScope: AtlassianConnectorStatus = {
  ...sAfterGithub,
  selectedSpaceCount: 0,
  selectedSpaces: [],
}

const sComplete: AtlassianConnectorStatus = {
  ...sAfterGithub,
  selectedSpaceCount: 1,
  selectedSpaces: [{ spaceKey: "DOC", spaceName: "Docs" }],
  syncTargetConfigured: true,
  syncTarget: {
    repositoryId: "r1",
    repositoryName: "acme/wiki",
    branch: "main",
  },
}

/** Forge installed; user must connect GitHub before choosing a repo. */
const sNeedGitHub: AtlassianConnectorStatus = {
  ...sInstall,
  isInstalled: true,
  installationStatus: "installed",
  isGithubLinked: false,
  syncTargetConfigured: false,
  syncTarget: null,
  selectedSpaceCount: 0,
  selectedSpaces: [],
}

/** GitHub linked; choose Confluence sync repository. */
const sBeforeTarget: AtlassianConnectorStatus = {
  ...sNeedGitHub,
  isGithubLinked: true,
}

const wizard = (extra?: {
  initialWaitForInstall?: boolean
  atlassianConnectionId?: string
}) => {
  const id =
    extra != null && "atlassianConnectionId" in extra
      ? extra.atlassianConnectionId
      : atlassianConnectionId
  return (
    <div className="min-h-[70vh] p-4">
      <ConfluenceSetupWizard
        orgSlug={orgSlug}
        atlassianConnectionId={id}
        isOpen
        onOpenChange={() => {}}
        initialWaitForInstall={extra?.initialWaitForInstall}
      />
    </div>
  )
}

const meta = {
  title: "Components/Connections/Atlassian/ConfluenceSetupWizard",
  component: ConfluenceSetupWizard,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: `
**End-to-end Confluence connection wizard** (Link Atlassian → Install Forge → optional wait →
Link GitHub → select sync repo → Confluence scope → done). Stories mock \`connectors/atlassian/status\`
and related calls so you can see each **panel** in the same \`Modal\` shell as production.

**Order in the product:** Not linked → register 3LO app (client id/secret in wizard) → Connect
Atlassian → Install Forge (click opens wait when hosted URL exists) → Link GitHub → Select sync
repo → Configure scope → Setup complete.
        `.trim(),
      },
    },
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof ConfluenceSetupWizard>

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  name: "01 / Loading",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => statusUrlMatches(request, atlassianConnectionId),
            async () => {
              await delay("infinite")
              return HttpResponse.json(s0)
            },
          ),
        ],
      },
    },
  },
}

export const StatusError: Story = {
  name: "02 / Status error",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => statusUrlMatches(request, atlassianConnectionId),
            () => new HttpResponse(null, { status: 500 }),
          ),
        ],
      },
    },
  },
}

export const LinkAtlassian: Story = {
  name: "03 / Link Atlassian (3LO app form + dev fallback)",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [status(s0), orgAtlassianOauthGet(false), orgAtlassianOauthPut],
      },
    },
  },
}

export const LinkAtlassianSignIn: Story = {
  name: "03b / Link Atlassian (3LO saved — sign in)",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          status(s0),
          orgAtlassianOauthGet(true, false),
          orgAtlassianOauthPut,
        ],
      },
    },
  },
}

export const LinkAtlassianGlobalEnv: Story = {
  name: "03c / Link Atlassian (global env OAuth only)",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [status(s0), orgAtlassianOauthGet(false, true)],
      },
    },
  },
}

export const InstallForge: Story = {
  name: "04 / Install Forge",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [status(sInstall), capabilitiesHosted, installationPost],
      },
    },
  },
}

export const WaitForInstall: Story = {
  name: "05 / Wait for install",
  render: () => wizard({ initialWaitForInstall: true }),
  parameters: {
    msw: {
      handlers: {
        page: [status(sInstall), capabilitiesHosted, installationPost],
      },
    },
  },
}

export const LinkGitHub: Story = {
  name: "06 / Link GitHub",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [status(sNeedGitHub)],
      },
    },
  },
}

export const SelectSyncTarget: Story = {
  name: "07 / Select sync target",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [status(sBeforeTarget), ...syncTargetHandlers],
      },
    },
  },
}

export const ConfigureScope: Story = {
  name: "08 / Configure scope",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [status(sNeedScope), ...scopeHandlers],
      },
    },
  },
}

export const SetupComplete: Story = {
  name: "09 / Setup complete",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [status(sComplete)],
      },
    },
  },
}

export const MissingConnectionId: Story = {
  name: "10 / Missing connection id",
  render: () => wizard({ atlassianConnectionId: undefined }),
  parameters: {
    msw: {
      handlers: {
        page: [statusUnscoped(s0)],
      },
    },
  },
}
