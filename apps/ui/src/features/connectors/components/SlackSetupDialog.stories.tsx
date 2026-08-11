import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { SlackSetupDialog } from "./SlackSetupDialog"

const orgSlug = "acme"
const connectionId = "story_slack_conn"

const installedStatus = {
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

function statusHandler(body: unknown) {
  return http.get(
    ({ request }) =>
      new URL(request.url).pathname.includes("/api/v1/connectors/slack/status"),
    () => HttpResponse.json(body),
  )
}

const configurationHandlers = [
  http.get(
    ({ request }) =>
      new URL(request.url).pathname.endsWith("/api/v1/github/installation"),
    () =>
      HttpResponse.json({
        id: "ghc_1",
        appSlug: "ctxpipe-agent",
        accountSlug: "acme",
      }),
  ),
  http.get(
    ({ request }) =>
      new URL(request.url).pathname.includes(
        "/api/v1/github/installation/repositories",
      ),
    () =>
      HttpResponse.json({
        repositories: [
          {
            id: 1,
            full_name: "acme/ctxpipe-context",
            html_url: "https://github.com/acme/ctxpipe-context",
            clone_url: "https://github.com/acme/ctxpipe-context.git",
            name: "ctxpipe-context",
            default_branch: "main",
          },
        ],
        repositorySelection: "selected",
        manageUrl:
          "https://github.com/organizations/acme/settings/installations/123",
        hasMore: false,
      }),
  ),
  http.get(
    ({ request }) =>
      new URL(request.url).pathname.endsWith("/api/v1/repositories"),
    () =>
      HttpResponse.json({
        items: [
          {
            id: "repo_1",
            name: "acme/ctxpipe-context",
            gitUrl: "https://github.com/acme/ctxpipe-context.git",
            githubConnectionId: "ghc_1",
          },
        ],
      }),
  ),
]

const meta = {
  title: "Components/Connections/Slack/SetupDialog",
  component: SlackSetupDialog,
  decorators: entryPageInnerDecorators,
  args: {
    orgSlug,
    connectionId,
    isOpen: true,
    onOpenChange: () => {},
  },
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof SlackSetupDialog>

export default meta

type Story = StoryObj<typeof meta>

export const AuthorizeSlack: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...installedStatus,
            isInstalled: false,
            installationStatus: null,
            teamName: null,
            isGithubLinked: false,
            setupPhase: "draft",
            syncTarget: null,
          }),
        ],
      },
    },
  },
}

export const ConnectGitHub: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...installedStatus,
            isGithubLinked: false,
            setupPhase: "draft",
            syncTarget: null,
          }),
        ],
      },
    },
  },
}

export const ChooseRepository: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...installedStatus,
            setupPhase: "draft",
            syncTarget: null,
          }),
          ...configurationHandlers,
        ],
      },
    },
  },
}

export const Live: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [statusHandler(installedStatus), ...configurationHandlers],
      },
    },
  },
}

export const StatusError: Story = {
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
