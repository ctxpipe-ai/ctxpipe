import { delay, HttpResponse, http } from "msw"

import { signedInHandlers } from "@/mocks/handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import { GithubConnectionCard } from "./GithubConnectionCard"

const orgSlug = "acme"
const connectionId = "story_github_conn"

const cardProps = { orgSlug, connectionId }

const meta = preview.meta({
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
  beforeEach: ({ msw }) => {
    msw.use(
      ...signedInHandlers,
      pendingWorkspaceUpgradesHandler({}),
      connectionUsageHandler([
        connectionUsageItem({
          workspaceSlug: "docs",
          workspaceName: "Docs",
        }),
      ]),
    )
  },
  parameters: {
    app: "root",
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
})

/**
 * GitHub connection card on the Connectors page: the GitHub App is installed on
 * an account with 12 repositories.
 */
export const Connected = meta.story({
  render: () => <GithubConnectionCard {...cardProps} />,
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) => {
          const u = new URL(request.url)
          if (!u.pathname.includes("/api/v1/github/installation")) return false
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
    )
  },
})

/**
 * GitHub connection card on the Connectors page: the installation request has
 * not returned, so the card is still checking.
 */
export const Checking = meta.story({
  render: () => <GithubConnectionCard {...cardProps} />,
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) => {
          const u = new URL(request.url)
          if (!u.pathname.includes("/api/v1/github/installation")) return false
          return u.searchParams.get("connectionId") === connectionId
        },
        async () => {
          await delay("infinite")
          return HttpResponse.json(null)
        },
      ),
    )
  },
})

/**
 * GitHub connection card on the Connectors page: the GitHub App is not
 * installed yet, so setup is not finished.
 */
export const NotYetConnected = meta.story({
  render: () => <GithubConnectionCard {...cardProps} />,
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) => {
          const u = new URL(request.url)
          if (!u.pathname.includes("/api/v1/github/installation")) return false
          return u.searchParams.get("connectionId") === connectionId
        },
        () => HttpResponse.json(null),
      ),
    )
  },
})

/**
 * GitHub card on the Connectors page: the installation read failed, so a row
 * under the head gives the cause and a Retry button without a click.
 */
export const CouldntLoad = meta.story({
  render: () => <GithubConnectionCard {...cardProps} />,
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) => {
          const u = new URL(request.url)
          if (!u.pathname.includes("/api/v1/github/installation")) return false
          return u.searchParams.get("connectionId") === connectionId
        },
        () => new HttpResponse(null, { status: 500 }),
      ),
    )
  },
})
