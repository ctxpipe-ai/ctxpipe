import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, fn, userEvent, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
  activeMemberRoleHandler,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import {
  pendingSetupHandlers,
  playPendingSetup,
} from "../mocks/pending-setup-stories"
import { PagerdutyConnectionCard } from "./PagerdutyConnectionCard"

const orgSlug = "acme"
const connectionId = "con_story_pagerduty"

const statusComplete = {
  isInstalled: true,
  installationStatus: "installed",
  accountName: "Acme",
  accountSubdomain: "acme",
  region: "us",
  isGithubLinked: true,
  selectedServiceCount: 2,
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
  oauthAppSaved: false,
  globalPagerdutyOAuthConfigured: true,
  oauthCallbackUrl:
    "https://app.example.com/api/v1/integrations/pagerduty/callback",
}

function pagerdutyStatus(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/pagerduty/status"))
        return false
      return u.searchParams.get("connectionId") === connectionId
    },
    () => HttpResponse.json(status),
  )
}

const meta = preview.meta({
  title: "Components/Connections/PagerdutyCard",
  component: PagerdutyConnectionCard,
  args: {
    orgSlug,
    connectionId,
    onOpenSetup: () => {},
  },
  beforeEach: ({ msw }) => {
    msw.use(
      ...signedInHandlers,
      activeMemberRoleHandler("admin"),
      pendingWorkspaceUpgradesHandler({}),
      connectionUsageHandler([
        connectionUsageItem({
          workspaceSlug: "docs",
          workspaceName: "Docs",
        }),
      ]),
    )
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
})

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>

const onOpenSetup = fn()

function card() {
  return (
    <PagerdutyConnectionCard
      orgSlug={orgSlug}
      connectionId={connectionId}
      onOpenSetup={onOpenSetup}
    />
  )
}

/**
 * PagerDuty card on the Connectors page, collapsed: the PagerDuty account is
 * connected, so the status is Connected.
 */
export const Connected = meta.story({
  render: () => shell(card()),
  beforeEach: ({ msw }) => {
    msw.use(pagerdutyStatus(statusComplete))
  },
})

/**
 * PagerDuty connection card on the Connectors page: the status request is still
 * loading.
 */
export const Checking = meta.story({
  render: () => shell(card()),
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          new URL(request.url).pathname.includes(
            "/api/v1/connectors/pagerduty/status",
          ),
        async () => {
          await delay("infinite")
          return HttpResponse.json(statusComplete)
        },
      ),
    )
  },
})

/**
 * PagerDuty connection card on the Connectors page: the status request failed,
 * so the card cannot show the connection.
 */
export const CouldntLoad = meta.story({
  render: () => shell(card()),
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          new URL(request.url).pathname.includes(
            "/api/v1/connectors/pagerduty/status",
          ),
        () => new HttpResponse(null, { status: 500 }),
      ),
    )
  },
})

const statusReads = fn()
const deleted = fn()

/**
 * PagerDuty connection card on the Connectors page: the setup is not complete,
 * so the card offers to continue or delete the draft.
 */
export const PendingSetup = meta.story({
  render: () => shell(card()),
  beforeEach: ({ msw }) => {
    msw.use(
      ...pendingSetupHandlers({
        orgSlug,
        provider: "pagerduty",
        statusReads,
        deleted,
      }),
      pagerdutyStatus({
        isInstalled: false,
        installationStatus: null,
        accountName: null,
        accountSubdomain: null,
        region: null,
        isGithubLinked: false,
        selectedServiceCount: 0,
        syncTargetConfigured: false,
        setupPhase: "draft",
        pendingConfigPullUrl: null,
        pendingConfigPrCreating: false,
        syncTarget: null,
      }),
    )
  },
  play: ({ canvasElement }) =>
    playPendingSetup({
      canvasElement,
      name: "PagerDuty",
      onOpen: onOpenSetup,
      statusReads,
      deleted,
    }),
})

/**
 * PagerDuty connection card on the Connectors page: PagerDuty revoked the
 * access, so the card shows Needs reconnect instead of Connected.
 */
export const RevokedLive = meta.story({
  render: () => shell(card()),
  beforeEach: ({ msw }) => {
    msw.use(
      pagerdutyStatus({
        ...statusComplete,
        isInstalled: false,
        installationStatus: "revoked",
      }),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Needs reconnect")
    expect(canvas.queryByText("Connected")).toBeNull()
    expect(
      canvas.getByRole("button", { name: "PagerDuty connector actions" }),
    ).toBeVisible()
  },
})

/**
 * PagerDuty connection card on the Connectors page: auth is done and each
 * Workspace sets its own scope, so the card shows no scope.
 */
export const ConnectedWithoutSyncRepository = meta.story({
  name: "Connected, scope set in each Workspace",
  render: () => shell(card()),
  beforeEach: ({ msw }) => {
    msw.use(
      pagerdutyStatus({
        ...statusComplete,
        setupPhase: "draft",
        isGithubLinked: false,
        selectedServiceCount: null,
        syncTargetConfigured: false,
        syncTarget: null,
      }),
    )
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Connected." },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Account")).toBeInTheDocument()
    // Each Workspace has its own scope, so the card shows none (ADR-050).
    await expect(canvas.queryAllByText("Scope")).toHaveLength(0)
    // Auth is done, so the card has no setup action; Manage adds sources.
    await expect(
      canvas.queryByRole("button", {
        name: /Set up|Connect PagerDuty|Manage scope|Choose services/,
      }),
    ).toBeNull()
  },
})

/**
 * PagerDuty connection card on the Connectors page: the access is revoked, and
 * the admin opens the menu to pick Reconnect PagerDuty.
 */
export const RevokedOpensReconnect = meta.story({
  name: "Revoked, reconnect opens setup",
  render: () => shell(card()),
  beforeEach: ({ msw }) => {
    msw.use(
      pagerdutyStatus({
        ...statusComplete,
        isInstalled: false,
        installationStatus: "revoked",
      }),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Needs reconnect")).toBeInTheDocument()
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "PagerDuty" }))
    const [reconnect] = await canvas.findAllByRole("button", {
      name: /^Reconnect PagerDuty/,
    })
    if (!reconnect) throw new Error("No Reconnect PagerDuty action")
    await userEvent.click(reconnect)
    await expect(onOpenSetup).toHaveBeenCalledTimes(1)
  },
})
