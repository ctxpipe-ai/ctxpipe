import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { connectionAnchorId } from "@/features/connectors/connectionAnchor"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import {
  atlassianCapabilitiesHandler,
  atlassianOauthHandler,
} from "@/mocks/atlassian-handlers"
import {
  buildkiteStatusHandler,
  buildkiteStoryStatus,
} from "@/mocks/buildkite-handlers"
import { githubAppInstalledHandlers, signedInHandlers } from "@/mocks/handlers"
import { linearOauthAppHandler } from "@/mocks/linear-handlers"
import { plainStatusHandler, plainStoryStatus } from "@/mocks/plain-handlers"
import {
  sideNavHandlers,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"
import {
  activeMemberRoleHandler,
  connectionUsageHandler,
} from "@/mocks/workspace-sources-handlers"
import {
  pendingWorkspaceUpgradesHandler,
  upgradeItemFixture,
} from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { ConnectorsPageContent } from "./$orgSlug.connectors"

const orgSlug = "acme"

const meta = {
  title: "Pages/Connections",
  tags: ["page"],
  parameters: {
    app: "org",
    queryClient: true,
    layout: "fullscreen",
    review: { kind: "page" },
    route: "/$orgSlug/connectors",
    msw: {
      handlers: {
        session: signedInHandlers,
        role: [activeMemberRoleHandler("admin")],
        ingestion: workspaceIngestionHandlers({}),
        pendingUpgrades: [pendingWorkspaceUpgradesHandler({})],
        // A story sets `page`. It comes first, so it wins over `shared`.
        page: [],
        // The reads that most stories share: the Workspaces of the side
        // nav and their chats, the GitHub App, the Linear OAuth app of the
        // host, and the Workspaces that use a connection (none).
        shared: [
          ...sideNavHandlers(),
          ...githubAppInstalledHandlers,
          linearOauthAppHandler(),
          connectionUsageHandler([]),
        ],
      },
    },
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Empty: Story = {
  render: () => <ConnectorsPageContent orgSlug={orgSlug} />,
  parameters: {
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: the org has no connections yet.",
    },
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    expect(canvas.getByText("Loading connectors")).toBeInTheDocument()
  },
  parameters: {
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: the connection list is still loading.",
    },
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
const pagerdutyId = "conn_pagerduty_1"

const connectionItems = [
  {
    id: githubId,
    type: "github" as const,
    status: "connected" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: forgeId,
    type: "forge" as const,
    status: "connected" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: slackId,
    type: "slack" as const,
    status: "connected" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: linearId,
    type: "linear" as const,
    status: "connected" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: notionId,
    type: "notion" as const,
    status: "connected" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: pagerdutyId,
    type: "pagerduty" as const,
    status: "connected" as const,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
]

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

const pagerdutyStatusComplete = {
  isInstalled: true,
  installationStatus: "installed",
  accountName: "Acme",
  accountSubdomain: "acme",
  region: "us",
  isGithubLinked: true,
  selectedServiceCount: 3,
  syncTargetConfigured: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/ingest",
    branch: "main",
    githubConnectionId: githubId,
  },
  oauthAppSaved: false,
  globalPagerdutyOAuthConfigured: true,
  oauthCallbackUrl:
    "https://app.example.com/api/v1/integrations/pagerduty/callback",
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

function pagerdutyStatusHandler(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname.endsWith("/api/v1/connectors/pagerduty/status") &&
        u.searchParams.get("connectionId") === pagerdutyId
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

function pageHandlers(
  handlers: ReturnType<typeof http.get>[],
  pendingUpgrades?: ReturnType<typeof pendingWorkspaceUpgradesHandler>,
  role?: "owner" | "member",
) {
  return {
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        // The meta answers an admin and "no pending upgrade"; these keys
        // replace them.
        ...(role ? { role: [activeMemberRoleHandler(role)] } : {}),
        page: handlers,
        ...(pendingUpgrades ? { pendingUpgrades: [pendingUpgrades] } : {}),
      },
    },
  }
}

const pageRender = () => <ConnectorsPageContent orgSlug={orgSlug} />

export const Full: Story = {
  render: pageRender,
  parameters: {
    ...pageHandlers([
      connectorsListHandler(),
      atlassianStatusHandler(atlassianStatusComplete),
      atlassianOauthHandler({ oauthAppSaved: true }, forgeId),
      notionStatusHandler(notionStatusComplete),
      githubInstallationHandler(githubInstallationComplete),
      linearStatusHandler(linearStatusComplete),
      slackStatusHandler(slackStatusComplete),
      pagerdutyStatusHandler(pagerdutyStatusComplete),
      // An expanded card reads "Used in" and the Workspace list.
      connectionUsageHandler([]),
      workspaceListHandler([]),
    ]),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: every connector is set up, and the user opens each card to see its account.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: "Notion" })
    // The head of each connector tile opens its details.
    const expanders = canvas.getAllByRole("button", {
      name: /^(GitHub|Confluence|Notion|Linear|Slack|PagerDuty)$/,
    })
    await expect(expanders).toHaveLength(6)
    for (const expander of expanders) await userEvent.click(expander)
    // A connection has no scope of its own: each Workspace has one, and
    // "Used in" lists it (ADR-050). The card shows the account only.
    await waitFor(() =>
      expect(canvas.getAllByText("Account")).toHaveLength(expanders.length),
    )
    await expect(canvas.queryAllByText("Scope")).toHaveLength(0)
  },
}

/**
 * Each Workspace of the org is below the newest format (CTX-935): a source
 * cannot be saved in any of them. The page says so before a connect flow
 * starts, links to the upgrade, and turns off Add connection.
 */
export const NeedsFormatUpgrade: Story = {
  render: pageRender,
  parameters: {
    ...pageHandlers(
      [
        connectorsListHandler(),
        atlassianStatusHandler(atlassianStatusComplete),
        atlassianOauthHandler({ oauthAppSaved: true }, forgeId),
        notionStatusHandler(notionStatusComplete),
        githubInstallationHandler(githubInstallationComplete),
        linearStatusHandler(linearStatusComplete),
        slackStatusHandler(slackStatusComplete),
        pagerdutyStatusHandler(pagerdutyStatusComplete),
        connectionUsageHandler([]),
        workspaceListHandler([docsWorkspace]),
      ],
      pendingWorkspaceUpgradesHandler({ docs: [upgradeItemFixture()] }),
      "owner",
    ),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: each Workspace needs a format upgrade, so the page links to the upgrade and turns off Add connection.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Upgrade a Workspace before you add a source")
    await expect(
      canvas.getByRole("link", { name: "Review upgrade: Docs" }),
    ).toHaveAttribute("href", "/acme/ws/docs?pane=settings#upgrades")
    await expect(
      canvas.getByRole("button", { name: "Add connection" }),
    ).toBeDisabled()
  },
}

/**
 * The Workspace is below the newest format and the scan wrote no upgrade row
 * yet. The read still lists it with its format, so the page blocks the start.
 */
export const NeedsFormatUpgradeNoRowYet: Story = {
  render: pageRender,
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as NeedsFormatUpgrade.",
    },
    ...pageHandlers(
      [
        connectorsListHandler(),
        atlassianStatusHandler(atlassianStatusComplete),
        atlassianOauthHandler({ oauthAppSaved: true }, forgeId),
        notionStatusHandler(notionStatusComplete),
        githubInstallationHandler(githubInstallationComplete),
        linearStatusHandler(linearStatusComplete),
        slackStatusHandler(slackStatusComplete),
        pagerdutyStatusHandler(pagerdutyStatusComplete),
        connectionUsageHandler([]),
        workspaceListHandler([docsWorkspace]),
      ],
      pendingWorkspaceUpgradesHandler({}, undefined, {
        formats: { docs: 0 },
      }),
      "owner",
    ),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: the Workspace is below the newest format and has no upgrade row yet, so Add connection is off.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Upgrade a Workspace before you add a source")
    await expect(
      canvas.getByRole("button", { name: "Add connection" }),
    ).toBeDisabled()
  },
}

/** With no connection yet, the empty state offers no start either. */
export const NeedsFormatUpgradeNoConnections: Story = {
  render: pageRender,
  parameters: {
    ...pageHandlers(
      [
        http.get(
          ({ request }) =>
            new URL(request.url).pathname === `/${orgSlug}/api/v1/connectors`,
          () => HttpResponse.json({ items: [] }),
        ),
        workspaceListHandler([docsWorkspace]),
      ],
      pendingWorkspaceUpgradesHandler({ docs: [upgradeItemFixture()] }),
      "member",
    ),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: no connections and a Workspace that needs an upgrade, so a member sees Ask an admin and no start.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Upgrade a Workspace before you add a source")
    await waitFor(() => expect(canvas.getByText("Ask an admin")).toBeVisible())
    await expect(
      canvas.getByRole("button", { name: "Add connection" }),
    ).toBeDisabled()
  },
}

export const InProgress: Story = {
  render: pageRender,
  parameters: {
    ...pageHandlers([
      connectorsListHandler(),
      githubInstallationHandler(null),
      atlassianOauthHandler({ oauthAppSaved: true }, forgeId),
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
      pagerdutyStatusHandler({
        ...pagerdutyStatusComplete,
        isGithubLinked: true,
        syncTargetConfigured: true,
        selectedServiceCount: 2,
        setupPhase: "awaiting_merge",
        pendingConfigPullUrl: "https://github.com/acme/ingest/pull/43",
      }),
    ]),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: several connectors have an unfinished setup or wait for a pull request merge.",
    },
  },
}

export const MixedHealth: Story = {
  render: pageRender,
  parameters: {
    ...pageHandlers([
      connectorsListHandler(),
      githubInstallationHandler(githubInstallationComplete),
      atlassianOauthHandler({ oauthAppSaved: true }, forgeId),
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
      pagerdutyStatusHandler({
        ...pagerdutyStatusComplete,
        setupPhase: "sync_failed",
      }),
    ]),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: some connections are healthy, some failed to sync or to save the config.",
    },
  },
}

export const CouldntLoad: Story = {
  render: pageRender,
  parameters: {
    ...pageHandlers([
      connectorsListHandler(),
      atlassianOauthHandler({ oauthAppSaved: true }, forgeId),
      statusFailed("/api/v1/github/installation", githubId),
      statusFailed("/api/v1/connectors/atlassian/status", forgeId),
      statusFailed("/api/v1/connectors/linear/status", linearId),
      statusFailed("/api/v1/connectors/notion/status", notionId),
      statusFailed("/api/v1/connectors/slack/status", slackId),
      statusFailed("/api/v1/connectors/pagerduty/status", pagerdutyId),
    ]),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: the status of each connector failed to load.",
    },
  },
}

/** The Atlassian account link returns here and opens the wizard again. */
export const ReopensConfluenceWizardAfterAccountLink: Story = {
  render: () => <ConnectorsPageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    // The dialog can mount again while the status loads, which detaches the
    // first heading. Query again on each try, so the check reads the live one.
    await waitFor(() =>
      expect(
        page.getByRole("heading", { name: "Set up Confluence connector" }),
      ).toBeVisible(),
    )
    // The alert says one short sentence. The technical detail is behind
    // "Show details", stays inside the alert box (CTX-1263), and never shows
    // the signed query of the install link.
    const title = await page.findByText(
      "Could not load the hosted install link",
      {},
      { timeout: 10_000 },
    )
    const alert = title.closest<HTMLElement>('[role="alert"]')
    if (!alert) throw new Error("No alert around the title")
    await userEvent.click(
      within(alert).getByRole("button", { name: "Show details" }),
    )
    await expect(
      await within(alert).findByText(/Runtime fallback/),
    ).toBeVisible()
    await expect(alert).not.toHaveTextContent("signature=")
    await document.fonts.ready
    await waitFor(() =>
      expect(alert.scrollWidth).toBeLessThanOrEqual(alert.clientWidth),
    )
  },
  parameters: {
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: the Atlassian link comes back, the Confluence setup opens again, and its install link failed to load.",
    },
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
      search: "?atlassianConnectionId=con_forge_story",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname === `/${orgSlug}/api/v1/connectors`,
            () => HttpResponse.json({ items: [] }),
          ),
          // The OAuth app is saved, and the install link fails to load.
          atlassianOauthHandler({ oauthAppSaved: true }, "con_forge_story"),
          atlassianCapabilitiesHandler("error", "con_forge_story"),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/status",
              ),
            () =>
              HttpResponse.json({
                isLinked: true,
                isInstalled: false,
                installationStatus: null,
                isGithubLinked: false,
                selectedSpaceCount: 0,
                syncTargetConfigured: false,
                setupPhase: "draft",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
                syncTarget: null,
                selectedSpaces: [],
              }),
          ),
        ],
      },
    },
  },
}

/** A Buildkite row shows its own card, and the catalog adds another one. */
export const BuildkiteFromCatalog: Story = {
  render: pageRender,
  parameters: {
    ...pageHandlers([
      http.get(
        ({ request }) =>
          new URL(request.url).pathname === `/${orgSlug}/api/v1/connectors`,
        () =>
          HttpResponse.json({
            items: [
              {
                id: "conn_buildkite_1",
                type: "buildkite",
                displayName: "acme",
                status: "connected",
                createdAt: "2025-01-01T00:00:00.000Z",
                updatedAt: "2025-01-02T00:00:00.000Z",
              },
            ],
          }),
      ),
      buildkiteStatusHandler(buildkiteStoryStatus({ webhookConfigured: true })),
      // The org shell lists the Workspaces.
      workspaceListHandler([]),
    ]),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: one Buildkite connection exists, and the catalog opens the setup of a second one.",
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        body.getByRole("button", { name: "Buildkite connector actions" }),
      ).toBeVisible(),
    )
    await expect(body.queryByText("GitHub")).toBeNull()
    await userEvent.click(body.getByRole("button", { name: "Add connection" }))
    await userEvent.click(
      await body.findByRole("button", {
        name: "Add another Buildkite connection",
      }),
    )
    const setup = await body.findByRole("heading", {
      name: "Set up Buildkite connector",
    })
    // The modal fades in; wait until the setup is visible.
    await waitFor(() => expect(setup).toBeVisible())
    await expect(body.getByLabelText("Organization slug")).toHaveValue("")
  },
}

/** A Plain row shows its own card, and the catalog adds another one. */
export const PlainFromCatalog: Story = {
  render: pageRender,
  parameters: {
    ...pageHandlers([
      http.get(
        ({ request }) =>
          new URL(request.url).pathname === `/${orgSlug}/api/v1/connectors`,
        () =>
          HttpResponse.json({
            items: [
              {
                id: "conn_plain_1",
                type: "plain",
                displayName: "Acme Support",
                status: "connected",
                createdAt: "2025-01-01T00:00:00.000Z",
                updatedAt: "2025-01-02T00:00:00.000Z",
              },
            ],
          }),
      ),
      plainStatusHandler(plainStoryStatus()),
      // The org shell lists the Workspaces.
      workspaceListHandler([]),
    ]),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: one Plain connection exists, and the catalog opens the setup of a second one.",
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        body.getByRole("button", { name: "Plain connector actions" }),
      ).toBeVisible(),
    )
    await expect(body.queryByText("GitHub")).toBeNull()
    await userEvent.click(body.getByRole("button", { name: "Add connection" }))
    await userEvent.click(
      await body.findByRole("button", { name: "Add another Plain connection" }),
    )
    const setup = await body.findByRole("heading", {
      name: "Set up Plain connector",
    })
    // The modal fades in; wait until the setup is visible.
    await waitFor(() => expect(setup).toBeVisible())
    await expect(body.getByLabelText("API key")).toHaveValue("")
  },
}

const linearRevokedId = "conn_linear_revoked"
const linearDraftId = "conn_linear_draft"

function linearStatusFor(connectionId: string, status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      return (
        u.pathname.endsWith("/api/v1/connectors/linear/status") &&
        u.searchParams.get("connectionId") === connectionId
      )
    },
    () => HttpResponse.json(status),
  )
}

/**
 * Two Linear connections: one needs a reconnect and one has an unfinished
 * setup. The catalog shows the worst state, and Fix takes the user to the
 * card of the connection that needs the reconnect.
 */
export const FixFromCatalog: Story = {
  render: pageRender,
  parameters: {
    ...pageHandlers([
      http.get(
        ({ request }) =>
          new URL(request.url).pathname === `/${orgSlug}/api/v1/connectors`,
        () =>
          HttpResponse.json({
            items: [
              {
                id: githubId,
                type: "github",
                displayName: "acme-corp",
                status: "connected",
                createdAt: "2025-01-01T00:00:00.000Z",
                updatedAt: "2025-01-02T00:00:00.000Z",
              },
              {
                id: linearDraftId,
                type: "linear",
                displayName: null,
                status: "setup_pending",
                createdAt: "2025-01-02T00:00:00.000Z",
                updatedAt: "2025-01-02T00:00:00.000Z",
              },
              {
                id: linearRevokedId,
                type: "linear",
                displayName: "Acme Platform",
                status: "needs_reconnect",
                createdAt: "2025-01-03T00:00:00.000Z",
                updatedAt: "2025-01-03T00:00:00.000Z",
              },
            ],
          }),
      ),
      githubInstallationHandler(githubInstallationComplete),
      linearStatusFor(linearRevokedId, {
        ...linearStatusComplete,
        isInstalled: false,
        installationStatus: "revoked",
        workspaceName: "Acme Platform",
      }),
      linearStatusFor(linearDraftId, {
        isInstalled: false,
        installationStatus: null,
        workspaceName: null,
        isGithubLinked: true,
        selectedScopeCount: 0,
        setupPhase: "draft",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        syncTarget: null,
      }),
      connectionUsageHandler([]),
      workspaceListHandler([]),
    ]),
    review: {
      purpose:
        "Connectors page, where an admin adds and manages the sources of the org: a Linear connection needs a reconnect, and Fix in the catalog moves the focus to its card.",
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        body.getByRole("button", { name: "Linear connector actions" }),
      ).toBeVisible(),
    )
    await userEvent.click(body.getByRole("button", { name: "Add connection" }))
    const dialog = await body.findByRole("dialog", { name: "Add connection" })
    await waitFor(() =>
      expect(within(dialog).getByText("Needs reconnect")).toBeVisible(),
    )
    await expect(
      within(dialog).getByRole("button", {
        name: "Add another Linear connection",
      }),
    ).toBeVisible()
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Fix Linear" }),
    )
    await waitFor(() =>
      expect(
        body.queryByRole("dialog", { name: "Add connection" }),
      ).not.toBeInTheDocument(),
    )
    // The card of the connection gets the focus and a mark that is not
    // only a color: the head of the tile says that it needs attention.
    const doc = canvasElement.ownerDocument
    const expand = (connectionId: string) => {
      const card = doc.getElementById(connectionAnchorId(connectionId))
      if (!card) throw new Error(`No card for ${connectionId}`)
      return within(card).getByRole("button", { name: "Linear" })
    }
    await waitFor(() => expect(expand(linearRevokedId)).toHaveFocus())
    await expect(expand(linearRevokedId)).toHaveAccessibleDescription(
      "Needs your attention",
    )
    await expect(expand(linearDraftId)).not.toHaveAccessibleDescription(
      "Needs your attention",
    )
    // The mark goes after a moment; the focus stays.
    await waitFor(
      () => expect(expand(linearRevokedId)).not.toHaveAccessibleDescription(),
      { timeout: 4000 },
    )
    await expect(expand(linearRevokedId)).toHaveFocus()
  },
}
