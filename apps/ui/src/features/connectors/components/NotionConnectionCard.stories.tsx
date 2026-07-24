import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { NotionConnectionCard } from "./NotionConnectionCard"

const orgSlug = "acme"
const connectionId = "story_notion_conn"

const statusComplete = {
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
    repositoryName: "acme/context",
    branch: "main",
  },
  selectedResources: [
    { externalId: "p1", type: "page", title: "Product decisions" },
    { externalId: "p2", type: "page", title: "Feature scoping" },
  ],
}

const meta = {
  title: "Components/Connections/NotionCard",
  component: NotionConnectionCard,
  decorators: entryPageInnerDecorators,
  parameters: {
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

export const Complete: Story = {
  render: () =>
    shell(
      <NotionConnectionCard
        orgSlug={orgSlug}
        connectionId={connectionId}
        onOpenSetup={() => {}}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/connectors/notion/status"))
                return false
              return u.searchParams.get("connectionId") === connectionId
            },
            () => HttpResponse.json(statusComplete),
          ),
        ],
      },
    },
  },
}

export const Loading: Story = {
  render: () =>
    shell(
      <NotionConnectionCard
        orgSlug={orgSlug}
        connectionId={connectionId}
        onOpenSetup={() => {}}
      />,
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
