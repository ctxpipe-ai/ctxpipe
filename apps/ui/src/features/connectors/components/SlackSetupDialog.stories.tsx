import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { CHOOSE_WORKSPACES_HINT } from "@/features/workspace-sources/ChooseWorkspacesStep"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { slackChannelsHandler } from "@/mocks/slack-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { workspaceSourceChangeHandlers } from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { SlackSetupDialog } from "./SlackSetupDialog"

const orgSlug = "acme"
const connectionId = "story_slack_conn"

const installedStatus = {
  isInstalled: true,
  installationStatus: "installed",
  teamName: "Acme Workspace",
  botHandle: "ctxpipe",
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

export const Loading: Story = {
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
              return HttpResponse.json({})
            },
          ),
        ],
      },
    },
  },
}

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

const addCalls: { method: string; path: string; body: unknown }[] = []
const onOpenChange = fn()

/**
 * After Slack and GitHub, the dialog maps the connection into Workspaces,
 * each with its own channels. No capture repository is needed.
 */
export const ChooseWorkspaces: Story = {
  args: { onOpenChange },
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...installedStatus,
            setupPhase: "draft",
            syncTarget: null,
          }),
          workspaceListHandler([docsWorkspace]),
          slackChannelsHandler(),
          ...workspaceSourceChangeHandlers(addCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    addCalls.length = 0
    onOpenChange.mockClear()
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await expect(
      await body.findByRole("button", { name: "Choose capture Workspace" }),
    ).toBeVisible()
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await expect(body.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
    const add = body.getByRole("button", { name: "Add to Workspaces" })
    await expect(add).toBeDisabled()
    await userEvent.click(
      await body.findByRole("checkbox", { name: /incidents/ }),
    )
    await userEvent.click(add)
    await waitFor(() => expect(addCalls).toHaveLength(1))
    await expect(addCalls[0]).toMatchObject({
      method: "POST",
      path: `/${orgSlug}/api/v1/workspaces/docs/sources`,
      body: {
        source: {
          provider: "slack",
          connectionId,
          scope: { channels: ["G0INC0001"] },
        },
      },
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  },
}

/** The optional @mention capture repository opens from the Workspaces step and comes back. */
export const CaptureWorkspace: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler(installedStatus),
          workspaceListHandler([docsWorkspace]),
          slackChannelsHandler(),
          ...configurationHandlers,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await expect(await body.findByText(/capture it into/)).toHaveTextContent(
      "acme/ctxpipe-context",
    )
    await expect(body.getByText(/\/invite @ctxpipe/)).toBeVisible()
    await userEvent.click(
      body.getByRole("button", { name: "Change capture Workspace" }),
    )
    await expect(
      await body.findByRole("heading", { name: "Choose a capture Workspace" }),
    ).toBeVisible()
    await userEvent.click(body.getByRole("button", { name: "Back" }))
    await expect(
      await body.findByRole("button", { name: "Add to Workspaces" }),
    ).toBeVisible()
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
