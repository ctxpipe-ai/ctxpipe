import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
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
  pagerdutyOauthConfigured: true,
  oauthAppSaved: false,
  globalPagerdutyOAuthConfigured: true,
  oauthCallbackUrl:
    "https://app.example.com/api/v1/integrations/pagerduty/callback",
  webhookUrl: "https://app.example.com/api/v1/webhook/pagerduty",
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
  decorators: entryPageInnerDecorators,
  parameters: {
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

function card() {
  return (
    <PagerdutyConnectionCard
      orgSlug={orgSlug}
      connectionId={connectionId}
      onOpenSetup={() => {}}
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

export const NotYetConnected: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
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
}

export const SyncFailed: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          pagerdutyStatus({ ...statusComplete, setupPhase: "sync_failed" }),
        ],
      },
    },
  },
}

export const ConfigurationPullRequestFailed: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          pagerdutyStatus({ ...statusComplete, setupPhase: "config_failed" }),
        ],
      },
    },
  },
}
