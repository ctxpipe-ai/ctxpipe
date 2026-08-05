import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { SlackConnectionCard } from "./SlackConnectionCard"

const orgSlug = "acme"
const connectionId = "story_slack_conn"

const statusLive = {
  isInstalled: true,
  installationStatus: "installed",
  teamName: "Acme Workspace",
  isGithubLinked: true,
  selectedChannelCount: 2,
  syncTargetConfigured: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  oldestDays: 90,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/ctxpipe-context",
    branch: "main",
    githubConnectionId: "ghc_1",
  },
  selectedChannels: [
    { channelId: "C1", name: "engineering", isPrivate: false },
    { channelId: "C2", name: "leadership", isPrivate: true },
  ],
}

const meta = {
  title: "Components/Connections/Slack/ConnectionCard",
  component: SlackConnectionCard,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof SlackConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>

function statusHandler(body: unknown) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/slack/status")) return false
      return u.searchParams.get("connectionId") === connectionId
    },
    () => HttpResponse.json(body),
  )
}

export const Live: Story = {
  render: () =>
    shell(
      <SlackConnectionCard orgSlug={orgSlug} connectionId={connectionId} />,
    ),
  parameters: {
    msw: { handlers: { page: [statusHandler(statusLive)] } },
  },
}

export const AwaitingMerge: Story = {
  render: () =>
    shell(
      <SlackConnectionCard orgSlug={orgSlug} connectionId={connectionId} />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...statusLive,
            setupPhase: "awaiting_merge",
            pendingConfigPullUrl:
              "https://github.com/acme/ctxpipe-context/pull/12",
          }),
        ],
      },
    },
  },
}

export const Loading: Story = {
  render: () =>
    shell(
      <SlackConnectionCard orgSlug={orgSlug} connectionId={connectionId} />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/slack/status",
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json(statusLive)
            },
          ),
        ],
      },
    },
  },
}
