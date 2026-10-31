import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import {
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
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
  decorators: entryPageInnerDecorators,
  parameters: {
    msw: {
      handlers: {
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

/** A Notion page syncs to a Workspace: the header is green. */
export const Connected: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        usage: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
              sources: [
                {
                  path: "sources/notion/notion.md",
                  provider: "notion",
                  status: "ok",
                  scopeSummary: "2 Notion pages",
                },
              ],
            }),
          ]),
        ],
        page: [notionStatus(statusComplete)],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getByText("Connected")).toBeVisible())
    await expect(canvas.queryByText("Awaiting merge")).toBeNull()
  },
}

/**
 * Setup added Notion to a Workspace, and the source pull request waits for
 * its merge. Nothing syncs yet, so the header is not green "Connected". The
 * "Used in" section links the pull request (CTX-1060).
 */
export const AwaitingMerge: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        usage: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
              stat: "",
              pendingChanges: [
                {
                  path: "sources/notion/notion.md",
                  provider: "notion",
                  action: "add",
                  pullRequestUrl: "https://github.com/acme/docs/pull/7",
                  createdAt: "2026-10-28T10:00:00Z",
                },
              ],
            }),
          ]),
        ],
        page: [notionStatus(statusComplete)],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Awaiting merge")).toBeVisible(),
    )
    await expect(canvas.queryByText("Connected")).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Expand Notion" }))
    await waitFor(() =>
      expect(canvas.getByText("Merge the pull request")).toBeVisible(),
    )
    await expect(
      canvas.getByRole("link", {
        name: "Review pull request. Opens GitHub in a new tab.",
      }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/7")
  },
}

/**
 * A connection from before Workspace sources reports its first sync in its
 * setup phase. Only that legacy binding shows "Syncing": the Workspace
 * source data has no sync time.
 */
export const Syncing: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [notionStatus({ ...statusComplete, setupPhase: "initial_sync" })],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getByText("Syncing")).toBeVisible())
    await expect(canvas.queryByText("Connected")).toBeNull()
  },
}

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

export const ConnectedWithoutSyncRepository: Story = {
  name: "Connected, scope set in each Workspace",
  render: () => shell(card()),
  parameters: {
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
    await userEvent.click(canvas.getByRole("button", { name: "Expand Notion" }))
    const [connect] = await canvas.findAllByRole("button", {
      name: /^Connect Notion/,
    })
    if (!connect) throw new Error("No Connect Notion action")
    await userEvent.click(connect)
    await expect(onOpenSetup).toHaveBeenCalledTimes(1)
  },
}
