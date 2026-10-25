import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, waitFor, within } from "storybook/test"

import {
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"

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
  setupPhase: "live",
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/ctxpipe-context",
    branch: "main",
    githubConnectionId: "ghc_1",
  },
}

const meta = {
  title: "Components/Connections/Slack/ConnectionCard",
  component: SlackConnectionCard,
  args: { orgSlug, connectionId },
  decorators: entryPageInnerDecorators,
  parameters: {
    msw: {
      handlers: {
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

export const Connected: Story = {
  render: () =>
    shell(
      <SlackConnectionCard orgSlug={orgSlug} connectionId={connectionId} />,
    ),
  parameters: {
    msw: { handlers: { page: [statusHandler(statusLive)] } },
  },
}

/** Installed without an @mention capture repository: the connection is ready for Workspace sources. */
export const ConnectedWithoutCaptureRepository: Story = {
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
            setupPhase: "draft",
            syncTarget: null,
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Slack connector actions" }),
      ).toBeVisible(),
    )
    expect(canvas.queryByText("Setup not finished")).toBeNull()
    expect(canvas.queryByText(/in a thread to capture it/)).toBeNull()
  },
}

export const Revoked: Story = {
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
            isInstalled: false,
            installationStatus: "revoked",
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Needs reconnect")
    expect(canvas.queryByText("Setup not finished")).toBeNull()
    expect(
      canvas.getByRole("button", { name: "Slack connector actions" }),
    ).toBeVisible()
  },
}

export const StatusError: Story = {
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
            () => HttpResponse.json({ error: "Unavailable" }, { status: 503 }),
          ),
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
