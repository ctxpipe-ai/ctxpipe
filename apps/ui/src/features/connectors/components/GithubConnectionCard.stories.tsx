import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { GithubConnectionCard } from "./GithubConnectionCard"

const orgSlug = "acme"
const connectionId = "story_github_conn"

const cardProps = { orgSlug, connectionId }

const meta = {
  title: "Components/Connections/GitHub/Card",
  component: GithubConnectionCard,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof GithubConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>

export const Loading: Story = {
  render: () => shell(<GithubConnectionCard {...cardProps} />),
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

export const WithInstallation: Story = {
  render: () => shell(<GithubConnectionCard {...cardProps} />),
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

export const NotLinked: Story = {
  name: "NotLinked",
  render: () => shell(<GithubConnectionCard {...cardProps} />),
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
  render: () => shell(<GithubConnectionCard {...cardProps} />),
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
