import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"

import { signedInHandlers } from "@/mocks/handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { GithubConnectionCard } from "./GithubConnectionCard"

const orgSlug = "acme"
const connectionId = "story_github_conn"

const cardProps = { orgSlug, connectionId }

const meta = {
  title: "Components/Connections/GitHub/ConnectionCard",
  component: GithubConnectionCard,
  args: cardProps,
  decorators: [
    (Story) => (
      <div className="w-xl max-w-full">
        <Story />
      </div>
    ),
  ],
  parameters: {
    app: "root",
    msw: {
      handlers: {
        session: signedInHandlers,
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
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
} satisfies Meta<typeof GithubConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

export const Connected: Story = {
  render: () => <GithubConnectionCard {...cardProps} />,
  parameters: {
    review: {
      purpose:
        "GitHub connection card on the Connectors page: the GitHub App is installed on an account with 12 repositories.",
    },
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/github/installation"))
                return false
              return u.searchParams.get("connectionId") === connectionId
            },
            () =>
              HttpResponse.json({
                id: connectionId,
                installationId: 999,
                accountSlug: "acme-sandbox",
                ingestionRepositoryCount: 12,
              }),
          ),
        ],
      },
    },
  },
}

export const Checking: Story = {
  render: () => <GithubConnectionCard {...cardProps} />,
  parameters: {
    review: {
      purpose:
        "GitHub connection card on the Connectors page: the installation request has not returned, so the card is still checking.",
    },
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/github/installation"))
                return false
              return u.searchParams.get("connectionId") === connectionId
            },
            async () => {
              await delay("infinite")
              return HttpResponse.json(null)
            },
          ),
        ],
      },
    },
  },
}

export const NotYetConnected: Story = {
  render: () => <GithubConnectionCard {...cardProps} />,
  parameters: {
    review: {
      purpose:
        "GitHub connection card on the Connectors page: the GitHub App is not installed yet, so setup is not finished.",
    },
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/github/installation"))
                return false
              return u.searchParams.get("connectionId") === connectionId
            },
            () => HttpResponse.json(null),
          ),
        ],
      },
    },
  },
}

export const CouldntLoad: Story = {
  render: () => <GithubConnectionCard {...cardProps} />,
  parameters: {
    review: {
      purpose:
        "GitHub card on the Connectors page: the installation read failed, so a row under the head gives the cause and a Retry button without a click.",
    },
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/github/installation"))
                return false
              return u.searchParams.get("connectionId") === connectionId
            },
            () => new HttpResponse(null, { status: 500 }),
          ),
        ],
      },
    },
  },
}
