import { useQuery } from "@tanstack/react-query"
import { delay, HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { Button } from "@/components/ui/Button"
import { CHOOSE_WORKSPACES_HINT } from "@/features/workspace-sources/ChooseWorkspacesStep"
import { workspaceSourcesOptions } from "@/features/workspace-sources/queries"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { githubAppMissingHandlers, signedInHandlers } from "@/mocks/handlers"
import { slackChannelsHandler } from "@/mocks/slack-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
  workspaceSourceAddHandlers,
  workspaceSourceChangeHandlers,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
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

const meta = preview.meta({
  title: "Components/Connections/Slack/SetupDialog",
  component: SlackSetupDialog,
  args: {
    orgSlug,
    connectionId,
    isOpen: true,
    onOpenChange: () => {},
  },
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, pendingWorkspaceUpgradesHandler({}))
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
})

/**
 * Slack setup dialog, which connects Slack and adds its channels to Workspaces:
 * the status request is still loading.
 */
export const Loading = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
  },
})

/**
 * Slack setup dialog, which connects Slack and adds its channels to Workspaces:
 * the first step, where the admin authorizes Slack.
 */
export const AuthorizeSlack = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      statusHandler({
        ...installedStatus,
        isInstalled: false,
        installationStatus: null,
        teamName: null,
        isGithubLinked: false,
        setupPhase: "draft",
        syncTarget: null,
      }),
    )
  },
})

/**
 * Slack setup dialog, which connects Slack and adds its channels to Workspaces:
 * Slack is authorized and the admin must connect GitHub next.
 */
export const ConnectGitHub = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      statusHandler({
        ...installedStatus,
        isGithubLinked: false,
        setupPhase: "draft",
        syncTarget: null,
      }),
      ...githubAppMissingHandlers,
    )
  },
})

const addCalls: { method: string; path: string; body: unknown }[] = []
const onOpenChange = fn()

/**
 * Slack setup dialog, after the Slack and GitHub steps: the admin adds a
 * channel to a Workspace, and the dialog moves to the merge step. Each
 * Workspace has its own channels, and no capture repository is necessary.
 */
export const ChooseWorkspaces = meta.story({
  args: { onOpenChange },
  beforeEach: ({ msw }) => {
    msw.use(
      statusHandler({
        ...installedStatus,
        setupPhase: "draft",
        syncTarget: null,
      }),
      workspaceListHandler([docsWorkspace]),
      connectionUsageHandler([]),
      slackChannelsHandler(),
      ...workspaceSourceAddHandlers(addCalls),
    )

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
    await expect(
      body.getByRole("link", { name: /^acme\/docs#7/ }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/7")
    await expect(onOpenChange).not.toHaveBeenCalled()
  },
})

/**
 * Slack setup dialog at its last step, Add to Workspaces: a box explains how an
 * @mention of the bot saves a thread, and no Workspace is selected yet. The
 * step has no repository picker (ADR-050).
 */
export const CaptureWorkspace = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      statusHandler(installedStatus),
      workspaceListHandler([docsWorkspace]),
      connectionUsageHandler([]),
      slackChannelsHandler(),
    )
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
})

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

/**
 * Slack setup dialog opened from Manage: it starts with the current Workspace
 * and channel checked. The admin saves one more channel, and the dialog moves
 * to the merge step.
 */
export const ManageKeepsTheCurrentScope = meta.story({
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as ChooseWorkspaces.",
    },
  },
  beforeEach: ({ msw }) => {
    msw.use(...manageHandlers(manageCalls))

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
})

/**
 * Slack setup dialog opened from Manage: the admin unchecks a Workspace and
 * saves, which removes the Slack source of that Workspace.
 */
export const ManageRemovesAnUncheckedWorkspace = meta.story({
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as ChooseWorkspaces.",
    },
  },
  beforeEach: ({ msw }) => {
    msw.use(...manageHandlers(manageCalls))

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
})

/**
 * Slack setup dialog, which connects Slack and adds its channels to Workspaces:
 * the status request failed with a server error.
 */
export const StatusError = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          new URL(request.url).pathname.includes(
            "/api/v1/connectors/slack/status",
          ),
        () => HttpResponse.json({ error: "Unavailable" }, { status: 503 }),
      ),
    )
  },
})

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
 * Slack setup dialog opened from Manage a second time: a merge changed the
 * channels while the dialog was closed. The dialog starts from the new
 * channels, not from the channels of the first open.
 */
export const ManageAgainShowsTheNewScope = meta.story({
  // The close fade and the open fade of the dialog overlap on a slow runner,
  // and the step then keeps the scope of the first open. Reduced motion
  // removes the fades, so the dialog unmounts at once.
  tags: ["reduced-motion"],
  render: (args) => <ManageButton {...args} />,
  beforeEach: ({ msw }) => {
    msw.use(
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
    )

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
})
