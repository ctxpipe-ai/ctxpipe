import type { Meta, StoryObj } from "@storybook/react-vite"
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
import { notionOauthAppHandler } from "../mocks/notion-oauth-app-msw"
import {
  pendingSetupHandlers,
  playPendingSetup,
} from "../mocks/pending-setup-stories"
import { NotionConnectionCard } from "./NotionConnectionCard"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const statusComplete = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme",
  isGithubLinked: true,
  selectedResourceCount: null,
  syncTargetConfigured: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/context",
    branch: "main",
  },
}

function notionStatus(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/notion/status")) return false
      return u.searchParams.get("connectionId") === connectionId
    },
    () => HttpResponse.json(status),
  )
}

const meta = {
  title: "Components/Connections/NotionCard",
  component: NotionConnectionCard,
  args: { orgSlug, connectionId, onOpenSetup: () => {} },
  parameters: {
    app: "root",
    review: { kind: "component" },
    msw: {
      handlers: {
        session: signedInHandlers,
        role: [activeMemberRoleHandler("admin")],
        pendingUpgrades: [pendingWorkspaceUpgradesHandler({})],
        usage: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
            }),
          ]),
        ],
      },
    },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof NotionConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>

const onOpenSetup = fn()

function card() {
  return (
    <NotionConnectionCard
      orgSlug={orgSlug}
      connectionId={connectionId}
      onOpenSetup={onOpenSetup}
    />
  )
}

/**
 * Notion connection card on the Connectors page: the Notion workspace is
 * connected and syncs to a context repository.
 */
export const Connected: Story = {
  render: () => shell(card()),
  parameters: {
    msw: { handlers: { page: [notionStatus(statusComplete)] } },
  },
}

/**
 * Notion connection card on the Connectors page: the status request is still
 * loading.
 */
export const Checking: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/status",
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json(statusComplete)
            },
          ),
        ],
      },
    },
  },
}

/**
 * Notion card on the Connectors page: the status read failed, so a row under
 * the head gives the cause and a Retry button without a click.
 */
export const CouldntLoad: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/status",
              ),
            () => new HttpResponse(null, { status: 500 }),
          ),
        ],
      },
    },
  },
}

const statusReads = fn()
const deleted = fn()

/**
 * Notion card on the Connectors page: the admin started the setup but did not
 * finish it, so the card offers Remove and the next step, Register OAuth app.
 */
export const PendingSetup: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          ...pendingSetupHandlers({
            orgSlug,
            provider: "notion",
            statusReads,
            deleted,
          }),
          notionStatus({
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
          }),
          notionOauthAppHandler({
            orgSlug,
            connectionId,
            oauthAppSaved: false,
            globalNotionOAuthConfigured: false,
          }),
        ],
      },
    },
  },
  play: ({ canvasElement }) =>
    playPendingSetup({
      canvasElement,
      name: "Notion",
      onOpen: onOpenSetup,
      statusReads,
      deleted,
    }),
}

/**
 * Notion connection card on the Connectors page: auth is done and each
 * Workspace sets its own scope, so the card shows no scope.
 */
export const ConnectedWithoutSyncRepository: Story = {
  name: "Connected, scope set in each Workspace",
  render: () => shell(card()),
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Connected." },
    msw: {
      handlers: {
        page: [
          notionStatus({
            ...statusComplete,
            setupPhase: "draft",
            isGithubLinked: false,
            syncTargetConfigured: false,
            syncTarget: null,
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Account")).toBeInTheDocument()
    // Each Workspace has its own scope, so the card shows none (ADR-050).
    await expect(canvas.queryAllByText("Scope")).toHaveLength(0)
    // Auth is done, so the card has no setup action; Manage adds sources.
    await expect(
      canvas.queryByRole("button", {
        name: /Set up|Connect Notion|Manage scope/,
      }),
    ).toBeNull()
  },
}

/**
 * Notion connection card on the Connectors page: Notion revoked the access, so
 * the card asks the admin to reconnect.
 */
export const RevokedNeedsReconnect: Story = {
  name: "Revoked, needs reconnect",
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          notionStatus({
            ...statusComplete,
            isInstalled: false,
            installationStatus: "revoked",
          }),
          notionOauthAppHandler({
            orgSlug,
            connectionId,
            oauthAppSaved: false,
            globalNotionOAuthConfigured: true,
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Needs reconnect")).toBeInTheDocument()
    onOpenSetup.mockClear()
    await userEvent.click(canvas.getByRole("button", { name: "Notion" }))
    const [connect] = await canvas.findAllByRole("button", {
      name: /^Connect Notion/,
    })
    if (!connect) throw new Error("No Connect Notion action")
    await userEvent.click(connect)
    await expect(onOpenSetup).toHaveBeenCalledTimes(1)
  },
}
