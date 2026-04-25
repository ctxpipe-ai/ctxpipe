import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { ConfluenceConnectionCard } from "./ConfluenceConnectionCard"

const orgSlug = "acme"
const connectionId = "story_forge_conn"

const cardProps = {
  orgSlug,
  connectionId,
  onOpenWizard: () => {},
  onOpenScope: () => {},
} as const

const statusNotLinked = {
  isLinked: false,
  isInstalled: false,
  installationStatus: null,
  isGithubLinked: false,
  selectedSpaceCount: 0,
  syncTargetConfigured: false,
  syncTarget: null,
  selectedSpaces: [] as { spaceKey: string; spaceName: string | null }[],
}

const statusComplete = {
  isLinked: true,
  isInstalled: true,
  installationStatus: "installed",
  isGithubLinked: true,
  selectedSpaceCount: 1,
  syncTargetConfigured: true,
  syncTarget: {
    repositoryId: "r1",
    repositoryName: "acme/wiki",
    branch: "main",
  },
  selectedSpaces: [{ spaceKey: "DOC", spaceName: "Docs" }],
}

const meta = {
  title: "Components/Connections/Atlassian/ConfluenceCard",
  component: ConfluenceConnectionCard,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof ConfluenceConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>

export const StatusLoading: Story = {
  name: "Loading",
  render: () => shell(<ConfluenceConnectionCard {...cardProps} />),
  parameters: {
    msw: {
      handlers: [
        http.get(
          ({ request }) => {
            const u = new URL(request.url)
            if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
              return false
            return u.searchParams.get("connectionId") === connectionId
          },
          async () => {
            await delay("infinite")
            return HttpResponse.json(statusNotLinked)
          },
        ),
      ],
    },
  },
}

export const StatusError: Story = {
  name: "Error",
  render: () => shell(<ConfluenceConnectionCard {...cardProps} />),
  parameters: {
    msw: {
      handlers: [
        http.get(
          ({ request }) => {
            const u = new URL(request.url)
            if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
              return false
            return u.searchParams.get("connectionId") === connectionId
          },
          () => new HttpResponse(null, { status: 500 }),
        ),
      ],
    },
  },
}

export const NotLinked: Story = {
  name: "InProgress/NotLinked",
  render: () => shell(<ConfluenceConnectionCard {...cardProps} />),
  parameters: {
    msw: {
      handlers: [
        http.get(
          ({ request }) => {
            const u = new URL(request.url)
            if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
              return false
            return u.searchParams.get("connectionId") === connectionId
          },
          () => HttpResponse.json(statusNotLinked),
        ),
      ],
    },
  },
}

export const LinkGitHub: Story = {
  name: "InProgress/LinkGitHub",
  render: () => shell(<ConfluenceConnectionCard {...cardProps} />),
  parameters: {
    msw: {
      handlers: [
        http.get(
          ({ request }) => {
            const u = new URL(request.url)
            if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
              return false
            return u.searchParams.get("connectionId") === connectionId
          },
          () =>
            HttpResponse.json({
              ...statusNotLinked,
              isLinked: true,
              isInstalled: true,
              isGithubLinked: false,
              installationStatus: "installed",
            }),
        ),
      ],
    },
  },
}

export const Complete: Story = {
  name: "Complete",
  render: () => shell(<ConfluenceConnectionCard {...cardProps} />),
  parameters: {
    msw: {
      handlers: [
        http.get(
          ({ request }) => {
            const u = new URL(request.url)
            if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
              return false
            return u.searchParams.get("connectionId") === connectionId
          },
          () => HttpResponse.json(statusComplete),
        ),
      ],
    },
  },
}
