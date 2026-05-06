import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { GithubConnectionCard } from "./GithubConnectionCard"

const orgSlug = "acme"
const connectionId = "story_github_conn"

const cardProps = { orgSlug, connectionId }

const meta = {
  title: "Components/Connections/GitHub/ConnectionCard",
  component: GithubConnectionCard,
  decorators: [
    (Story) => (
      <div className="w-full max-w-xl">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof GithubConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

export const ConnectionCard: Story = {
  render: () => <GithubConnectionCard {...cardProps} />,
  parameters: {
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

export const Loading: Story = {
  render: () => <GithubConnectionCard {...cardProps} />,
  parameters: {
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

export const NotLinked: Story = {
  render: () => <GithubConnectionCard {...cardProps} />,
  parameters: {
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

export const ErrorState: Story = {
  name: "Error",
  render: () => <GithubConnectionCard {...cardProps} />,
  parameters: {
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
