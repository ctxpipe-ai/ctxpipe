import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
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
  setupPhase: "draft",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
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
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "r1",
    repositoryName: "acme/wiki",
    branch: "main",
  },
  selectedSpaces: [{ spaceKey: "DOC", spaceName: "Docs" }],
}

function atlassianStatus(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
        return false
      return u.searchParams.get("connectionId") === connectionId
    },
    () => HttpResponse.json(status),
  )
}

const orgAtlassianOauthHandler = http.get(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname === `/${orgSlug}/api/v1/org/atlassian-oauth` &&
      u.searchParams.get("connectionId") === connectionId
    )
  },
  ({ request }) =>
    HttpResponse.json({
      oauthAppSaved: true,
      atlassianOAuthClientId: "story-client",
      globalAtlassianOAuthConfigured: false,
      oauthCallbackUrl: `${new URL(request.url).origin}/api/v1/integrations/atlassian/callback`,
      atlassianCreateUrl:
        "https://developer.atlassian.com/cloud/oauth-2-3lo-apps",
    }),
)

const meta = {
  title: "Components/Connections/Atlassian/ConnectionCard",
  component: ConfluenceConnectionCard,
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
} satisfies Meta<typeof ConfluenceConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

export const Connected: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [atlassianStatus(statusComplete), orgAtlassianOauthHandler],
      },
    },
  },
}

export const Checking: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [
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
          orgAtlassianOauthHandler,
        ],
      },
    },
  },
}

export const CouldntLoad: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
                return false
              return u.searchParams.get("connectionId") === connectionId
            },
            () => new HttpResponse(null, { status: 500 }),
          ),
          orgAtlassianOauthHandler,
        ],
      },
    },
  },
}

export const NotYetConnected: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [atlassianStatus(statusNotLinked), orgAtlassianOauthHandler],
      },
    },
  },
}

export const LinkGitHub: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          atlassianStatus({
            ...statusNotLinked,
            isLinked: true,
            isInstalled: true,
            isGithubLinked: false,
            installationStatus: "installed",
          }),
          orgAtlassianOauthHandler,
        ],
      },
    },
  },
}
