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

const meta = {
  title: "Components/Connections/PagerdutyCard",
  component: PagerdutyConnectionCard,
  args: {
    orgSlug,
    connectionId,
    onOpenSetup: () => {},
  },
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
} satisfies Meta<typeof PagerdutyConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

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

export const Connected: Story = {
  render: () => shell(card()),
  parameters: {
    msw: { handlers: { page: [pagerdutyStatus(statusComplete)] } },
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
                "/api/v1/connectors/pagerduty/status",
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
                "/api/v1/connectors/pagerduty/status",
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
        ],
      },
    },
  },
  play: ({ canvasElement }) =>
    playPendingSetup({
      canvasElement,
      name: "PagerDuty",
      onOpen: onOpenSetup,
      statusReads,
      deleted,
    }),
}

export const RevokedLive: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          pagerdutyStatus({
            ...statusComplete,
            isInstalled: false,
            installationStatus: "revoked",
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Needs reconnect")
    expect(canvas.queryByText("Connected")).toBeNull()
    expect(
      canvas.getByRole("button", { name: "PagerDuty connector actions" }),
    ).toBeVisible()
  },
}

export const ConnectedWithoutSyncRepository: Story = {
  name: "Connected, scope set in each Workspace",
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          pagerdutyStatus({
            ...statusComplete,
            setupPhase: "draft",
            isGithubLinked: false,
            selectedServiceCount: null,
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
        name: /Set up|Connect PagerDuty|Manage scope|Choose services/,
      }),
    ).toBeNull()
  },
}

export const RevokedOpensReconnect: Story = {
  name: "Revoked, reconnect opens setup",
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          pagerdutyStatus({
            ...statusComplete,
            isInstalled: false,
            installationStatus: "revoked",
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Needs reconnect")).toBeInTheDocument()
    onOpenSetup.mockClear()
    await userEvent.click(
      canvas.getByRole("button", { name: "Expand PagerDuty" }),
    )
    const [reconnect] = await canvas.findAllByRole("button", {
      name: /^Reconnect PagerDuty/,
    })
    if (!reconnect) throw new Error("No Reconnect PagerDuty action")
    await userEvent.click(reconnect)
    await expect(onOpenSetup).toHaveBeenCalledTimes(1)
  },
}
