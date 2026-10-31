import type { Meta, StoryObj } from "@storybook/react-vite"
import { useQuery } from "@tanstack/react-query"
import { delay, HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { Button } from "@/components/ui/Button"
import { CHOOSE_WORKSPACES_HINT } from "@/features/workspace-sources/ChooseWorkspacesStep"
import { workspaceSourcesOptions } from "@/features/workspace-sources/queries"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { slackChannelsHandler } from "@/mocks/slack-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
  workspaceSourceChangeHandlers,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"

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
          connectionUsageHandler([]),
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
      await body.findByRole("region", { name: "How capture works" }),
    ).toBeInTheDocument()
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
    // A source change opens a pull request; capture starts after the merge.
    await waitFor(() =>
      expect(
        body.getByRole("heading", {
          name: "Merge the pull request",
        }),
      ).toBeVisible(),
    )
    // The merge is the last step of the setup, and the pull request is the
    // primary action.
    await expect(
      body.getByRole("listitem", { current: "step" }),
    ).toHaveTextContent("Merge the pull request")
    await expect(
      body.getByRole("link", {
        name: "Review pull request acme/docs#7. Opens GitHub in a new tab.",
      }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/7")
    await expect(onOpenChange).not.toHaveBeenCalled()
  },
}

/** The Workspaces step explains capture and offers no repository picker (ADR-050). */
export const CaptureWorkspace: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler(installedStatus),
          workspaceListHandler([docsWorkspace]),
          connectionUsageHandler([]),
          slackChannelsHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    // The dialog fades in, so wait until its text is visible.
    const saves = await body.findByText(
      /saves the thread to each Workspace with that/,
    )
    await waitFor(() => expect(saves).toBeVisible())
    await waitFor(() =>
      expect(body.getByText(/\/invite @ctxpipe/)).toBeVisible(),
    )
    await expect(
      body.queryByRole("button", { name: /capture Workspace/ }),
    ).toBeNull()
    await expect(
      body.getByRole("button", { name: "Add to Workspaces" }),
    ).toBeVisible()
  },
}

/** The Docs Workspace already captures #eng through a Slack source. */
const manageHandlers = (calls: typeof addCalls) => [
  statusHandler(installedStatus),
  workspaceListHandler([docsWorkspace]),
  connectionUsageHandler([
    connectionUsageItem({
      workspaceSlug: docsWorkspace.slug,
      workspaceName: docsWorkspace.displayName,
      sources: [
        {
          path: "sources/slack/slack.md",
          provider: "slack",
          status: "ok",
          scopeSummary: "1 Slack channel",
        },
      ],
    }),
  ]),
  workspaceSourcesHandler(
    workspaceSourceList({
      items: [
        workspaceSourceFixture({
          path: "sources/slack/slack.md",
          provider: "slack",
          connectionId,
          scope: { channels: ["C0ENG0001"] },
        }),
      ],
    }),
  ),
  slackChannelsHandler(),
  ...workspaceSourceChangeHandlers(calls),
]

const manageCalls: typeof addCalls = []

/** Manage starts from the current Workspaces and channels, and saves a change. */
export const ManageKeepsTheCurrentScope: Story = {
  parameters: { msw: { handlers: { page: manageHandlers(manageCalls) } } },
  beforeEach: () => {
    manageCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        body.getByRole("checkbox", { name: docsWorkspace.displayName }),
      ).toBeChecked(),
    )
    await waitFor(() =>
      expect(body.getByRole("checkbox", { name: /^#?\s*eng$/ })).toBeChecked(),
    )
    const save = body.getByRole("button", { name: "Save changes" })
    await expect(save).toBeDisabled()
    await userEvent.click(body.getByRole("checkbox", { name: /incidents/ }))
    await userEvent.click(save)
    await waitFor(() => expect(manageCalls).toHaveLength(1))
    await expect(manageCalls[0]).toMatchObject({
      method: "PUT",
      path: `/${orgSlug}/api/v1/workspaces/${docsWorkspace.slug}/sources`,
      body: {
        path: "sources/slack/slack.md",
        source: {
          provider: "slack",
          connectionId,
          scope: { channels: ["C0ENG0001", "G0INC0001"] },
        },
      },
    })
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Merge the pull request" }),
      ).toBeVisible(),
    )
  },
}

/** Unchecking a Workspace on Manage removes its Slack source. */
export const ManageRemovesAnUncheckedWorkspace: Story = {
  parameters: { msw: { handlers: { page: manageHandlers(manageCalls) } } },
  beforeEach: () => {
    manageCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(body.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(manageCalls).toHaveLength(1))
    await expect(manageCalls[0]).toMatchObject({
      method: "DELETE",
      path: `/${orgSlug}/api/v1/workspaces/${docsWorkspace.slug}/sources`,
      query: { path: "sources/slack/slack.md" },
    })
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

/** The Slack channels of the Docs source on the server. */
let docsChannels = ["C0ENG0001"]

/**
 * The connector card: Manage opens the dialog, and Close closes it. The app
 * keeps the response in its cache after the dialog closes. Storybook does
 * not, so this observer keeps the Docs sources in the cache.
 */
function ManageButton(props: ComponentProps<typeof SlackSetupDialog>) {
  const [isOpen, setIsOpen] = useState(false)
  useQuery(workspaceSourcesOptions(orgSlug, docsWorkspace.slug))
  return (
    <>
      <Button onPress={() => setIsOpen(true)}>Manage</Button>
      <SlackSetupDialog {...props} isOpen={isOpen} onOpenChange={setIsOpen} />
    </>
  )
}

/**
 * A merge changes the channels while the dialog is closed. Manage then
 * starts from the new channels, not from the channels of an earlier request.
 */
export const ManageAgainShowsTheNewScope: Story = {
  // The close fade and the open fade of the dialog overlap on a slow runner,
  // and the step then keeps the scope of the first open. Reduced motion
  // removes the fades, so the dialog unmounts at once.
  tags: ["reduced-motion"],
  render: (args) => <ManageButton {...args} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler(installedStatus),
          workspaceListHandler([docsWorkspace]),
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: docsWorkspace.slug,
              workspaceName: docsWorkspace.displayName,
              sources: [
                {
                  path: "sources/slack/slack.md",
                  provider: "slack",
                  status: "ok",
                  scopeSummary: "1 Slack channel",
                },
              ],
            }),
          ]),
          http.get(`/${orgSlug}/api/v1/workspaces/docs/sources`, () =>
            HttpResponse.json(
              workspaceSourceList({
                items: [
                  workspaceSourceFixture({
                    path: "sources/slack/slack.md",
                    provider: "slack",
                    connectionId,
                    scope: { channels: docsChannels },
                  }),
                ],
              }),
            ),
          ),
          slackChannelsHandler(),
        ],
      },
    },
  },
  beforeEach: () => {
    docsChannels = ["C0ENG0001"]
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(await body.findByRole("button", { name: "Manage" }))
    await waitFor(() =>
      expect(body.getByRole("checkbox", { name: /^#?\s*eng$/ })).toBeChecked(),
    )
    await userEvent.click(body.getByRole("button", { name: "Close" }))
    await waitFor(() =>
      expect(
        body.queryByRole("checkbox", { name: /^#?\s*eng$/ }),
      ).not.toBeInTheDocument(),
    )

    docsChannels = ["G0INC0001"]
    // The open dialog hides the page from the accessibility tree, so this
    // finds Manage only after the dialog has unmounted. A new dialog then
    // starts from a new read.
    await userEvent.click(await body.findByRole("button", { name: "Manage" }))
    await waitFor(() =>
      expect(body.getByRole("checkbox", { name: /incidents/ })).toBeChecked(),
    )
    await waitFor(() =>
      expect(
        body.getByRole("checkbox", { name: /^#?\s*eng$/ }),
      ).not.toBeChecked(),
    )
  },
}
