import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import {
  authConfigHandler,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { ConnectorsPageContent } from "./$orgSlug.connectors"

const orgSlug = "acme"

const storySession = [
  authConfigHandler,
  sessionSignedInHandler({
    id: "user_storybook",
    onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
  }),
  organizationListWithOrgHandler,
] as const

const meta = {
  title: "Pages/Connections",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Empty: Story = {
  render: () => <ConnectorsPageContent orgSlug={orgSlug} />,
  parameters: {
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: [
        ...storySession,
        http.get(
          ({ request }) => {
            const p = new URL(request.url).pathname
            return p === `/${orgSlug}/api/v1/connectors`
          },
          () => HttpResponse.json({ items: [] }),
        ),
      ],
    },
  },
}

export const Loading: Story = {
  render: () => <ConnectorsPageContent orgSlug={orgSlug} />,
  parameters: {
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: [
        ...storySession,
        http.get(
          ({ request }) => {
            const p = new URL(request.url).pathname
            return p === `/${orgSlug}/api/v1/connectors`
          },
          async () => {
            await delay("infinite")
            return HttpResponse.json({ items: [] })
          },
        ),
      ],
    },
  },
}

const forgeId = "conn_forge_1"
const githubId = "conn_github_1"

const atlassianStatusComplete = {
  isLinked: true,
  isInstalled: true,
  installationStatus: "installed",
  isGithubLinked: true,
  selectedSpaceCount: 1,
  syncTargetConfigured: true,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/ingest",
    branch: "main",
  },
  selectedSpaces: [{ spaceKey: "ENG", spaceName: "Engineering" }],
}

export const Full: Story = {
  render: () => <ConnectorsPageContent orgSlug={orgSlug} />,
  parameters: {
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: [
        ...storySession,
        http.get(
          ({ request }) => {
            const p = new URL(request.url).pathname
            return p === `/${orgSlug}/api/v1/connectors`
          },
          () =>
            HttpResponse.json({
              items: [
                {
                  id: forgeId,
                  type: "forge" as const,
                  createdAt: "2025-01-01T00:00:00.000Z",
                  updatedAt: "2025-01-02T00:00:00.000Z",
                },
                {
                  id: githubId,
                  type: "github" as const,
                  createdAt: "2025-01-01T00:00:00.000Z",
                  updatedAt: "2025-01-02T00:00:00.000Z",
                },
              ],
            }),
        ),
        http.get(
          ({ request }) => {
            const u = new URL(request.url)
            if (!u.pathname.endsWith("/api/v1/connectors/atlassian/status"))
              return false
            if (u.searchParams.get("connectionId") !== forgeId) return false
            return true
          },
          () => HttpResponse.json(atlassianStatusComplete),
        ),
        http.get(
          ({ request }) => {
            const u = new URL(request.url)
            if (!u.pathname.includes("/api/v1/github/installation"))
              return false
            if (u.searchParams.get("connectionId") !== githubId) return false
            return true
          },
          () =>
            HttpResponse.json({
              id: githubId,
              installationId: 12345,
              accountSlug: "acme-corp",
              ingestionRepositoryCount: 3,
            }),
        ),
      ],
    },
  },
}
