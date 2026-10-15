import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, fn, userEvent, within } from "storybook/test"
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

export const Connected: Story = {
  render: () => shell(card()),
  parameters: {
    msw: { handlers: { page: [notionStatus(statusComplete)] } },
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
