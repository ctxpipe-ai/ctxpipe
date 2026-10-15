import type { Meta, StoryObj } from "@storybook/react-vite"
import { useQuery } from "@tanstack/react-query"
import { delay, HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { Button } from "@/components/ui/Button"
import { CHOOSE_WORKSPACES_HINT } from "@/features/workspace-sources/ChooseWorkspacesStep"
import { workspaceSourcesOptions } from "@/features/workspace-sources/queries"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { linearAvailableScopesHandler } from "@/mocks/linear-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
  workspaceSourceChangeHandlers,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import type { LinearConnectorStatus } from "../../queries/linear-connector"
import { LinearSetupWizard } from "./LinearSetupWizard"

const orgSlug = "acme"
const connectionId = "linear_story"
const baseStatus: LinearConnectorStatus = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme Product",
}

function statusHandler(status: LinearConnectorStatus) {
  return http.get(`/${orgSlug}/api/v1/connectors/linear/status`, () =>
    HttpResponse.json(status),
  )
}

function oauthAppHandler(input: {
  globalLinearOauthConfigured: boolean
  oauthAppSaved: boolean
  oauthClientId?: string | null
}) {
  return http.get(`/${orgSlug}/api/v1/connectors/linear/oauth-app`, () =>
    HttpResponse.json({
      linearOauthConfigured:
        input.globalLinearOauthConfigured || input.oauthAppSaved,
      globalLinearOauthConfigured: input.globalLinearOauthConfigured,
      oauthCallbackUrl:
        "https://app.example.com/api/v1/integrations/linear/callback",
      linearWebhookUrl: "https://app.example.com/api/v1/webhook/linear",
      linearCreateUrl: "https://linear.app/settings/api/applications/new",
      oauthAppSaved: input.oauthAppSaved,
      oauthClientId: input.oauthClientId ?? null,
    }),
  )
}

const meta = {
  title: "Components/Connections/Linear/SetupWizard",
  component: LinearSetupWizard,
  decorators: entryPageInnerDecorators,
  args: {
    orgSlug,
    connectionId,
    isOpen: true,
    onOpenChange: fn(),
    onConnectionIdChange: fn(),
  },
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof LinearSetupWizard>

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(`/${orgSlug}/api/v1/connectors/linear/status`, async () => {
            await delay("infinite")
            return HttpResponse.json(baseStatus)
          }),
        ],
      },
    },
  },
}

export const ConnectWorkspace: Story = {
  args: { connectionId: undefined },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: true,
            oauthAppSaved: false,
          }),
          statusHandler({
            ...baseStatus,
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
          }),
        ],
      },
    },
  },
}

export const RegisterOauthApp: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: false,
            oauthAppSaved: false,
          }),
          statusHandler({
            ...baseStatus,
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
          }),
        ],
      },
    },
  },
}

export const RegisterOauthAppSaved: Story = {
  args: { connectionId },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: false,
            oauthAppSaved: true,
            oauthClientId: "lin_client",
          }),
          statusHandler({
            ...baseStatus,
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
          }),
        ],
      },
    },
  },
}

const addCalls: { method: string; path: string; body: unknown }[] = []
const onOpenChange = fn()

/** After the OAuth grant, the wizard maps the connection into Workspaces. */
export const ChooseWorkspaces: Story = {
  args: { onOpenChange },
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: true,
            oauthAppSaved: false,
          }),
          statusHandler(baseStatus),
          workspaceListHandler([docsWorkspace]),
          linearAvailableScopesHandler(),
          connectionUsageHandler([]),
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
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await expect(body.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
    const add = body.getByRole("button", { name: "Add to Workspaces" })
    await expect(add).toBeDisabled()
    await userEvent.click(
      await body.findByRole("checkbox", { name: /Engineering/ }),
    )
    await userEvent.click(add)
    await waitFor(() => expect(addCalls).toHaveLength(1))
    await expect(addCalls[0]).toMatchObject({
      method: "POST",
      path: `/${orgSlug}/api/v1/workspaces/docs/sources`,
      body: {
        source: {
          provider: "linear",
          connectionId,
          scope: { teams: ["ENG"] },
        },
      },
    })
    // The add opened a pull request: the dialog stays open on the merge step.
    await expect(
      await body.findByRole("heading", { name: "Merge the pull request" }),
    ).toBeVisible()
    await expect(
      body.getByRole("link", { name: "acme/docs#7" }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/7")
    await expect(onOpenChange).not.toHaveBeenCalled()
  },
}

const pullRequestUrl = "https://github.com/acme/docs/pull/7"
/** Whether the story user merged the pull request on GitHub. */
let merged = false

/**
 * The user merges the pull request on GitHub. The merge step reads the
 * Workspace sources again and shows the merge.
 */
export const MergeStepShowsTheMerge: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: true,
            oauthAppSaved: false,
          }),
          statusHandler(baseStatus),
          workspaceListHandler([docsWorkspace]),
          linearAvailableScopesHandler(),
          connectionUsageHandler([]),
          http.post(`/${orgSlug}/api/v1/workspaces/docs/sources`, () =>
            HttpResponse.json({
              outcome: "pull_request",
              path: "linear",
              pullRequestUrl,
            }),
          ),
          http.get(`/${orgSlug}/api/v1/workspaces/docs/sources`, () =>
            HttpResponse.json(
              merged
                ? workspaceSourceList({
                    items: [
                      workspaceSourceFixture({
                        path: "linear",
                        provider: "linear",
                        connectionId,
                        scope: { teams: ["ENG"] },
                      }),
                    ],
                  })
                : workspaceSourceList({
                    pendingChanges: [
                      {
                        path: "linear",
                        provider: "linear",
                        action: "add",
                        pullRequestUrl,
                        createdAt: "2026-10-14T11:53:09Z",
                      },
                    ],
                  }),
            ),
          ),
        ],
      },
    },
  },
  beforeEach: () => {
    merged = false
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(
      await body.findByRole("checkbox", { name: /Engineering/ }),
    )
    await userEvent.click(
      body.getByRole("button", { name: "Add to Workspaces" }),
    )
    await expect(
      await body.findByRole("heading", { name: "Merge the pull request" }),
    ).toBeVisible()

    merged = true
    await expect(
      await body.findByRole(
        "heading",
        { name: "Pull request merged" },
        { timeout: 10_000 },
      ),
    ).toBeVisible()
    await expect(body.getByText("Merged")).toBeVisible()
    await expect(
      body.getByRole("link", { name: "acme/docs#7" }),
    ).toHaveAttribute("href", pullRequestUrl)
  },
}

const manageCalls: typeof addCalls = []

/**
 * The Docs Workspace already syncs the Engineering team through this
 * connection. Manage starts from that scope and saves a change.
 */
export const ManageKeepsTheCurrentScope: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: true,
            oauthAppSaved: false,
          }),
          statusHandler(baseStatus),
          workspaceListHandler([docsWorkspace]),
          linearAvailableScopesHandler(),
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: docsWorkspace.slug,
              workspaceName: docsWorkspace.displayName,
              sources: [
                {
                  path: "linear-3",
                  provider: "linear",
                  status: "ok",
                  scopeSummary: "1 Linear team",
                },
              ],
            }),
          ]),
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                workspaceSourceFixture({
                  path: "linear-3",
                  provider: "linear",
                  connectionId,
                  scope: { teams: ["ENG"] },
                }),
              ],
            }),
          ),
          ...workspaceSourceChangeHandlers(manageCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    manageCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await expect(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    ).toBeChecked()
    await expect(
      await body.findByRole("checkbox", { name: /Engineering/ }),
    ).toBeChecked()
    const save = body.getByRole("button", { name: "Save changes" })
    await expect(save).toBeDisabled()
    await userEvent.click(body.getByRole("checkbox", { name: /Operations/ }))
    await userEvent.click(save)
    await waitFor(() => expect(manageCalls).toHaveLength(1))
    await expect(manageCalls[0]).toMatchObject({
      method: "PUT",
      path: `/${orgSlug}/api/v1/workspaces/${docsWorkspace.slug}/sources/linear-3`,
      body: {
        source: {
          provider: "linear",
          connectionId,
          scope: { teams: expect.arrayContaining(["ENG", "OPS"]) },
        },
      },
    })
  },
}

/** The Linear teams of the Docs source on the server. */
let currentTeams = ["ENG"]

/**
 * The connector card: Manage opens the dialog, and Close closes it. The app
 * keeps the response in its cache after the dialog closes. Storybook does
 * not, so this observer keeps the Docs sources in the cache.
 */
function ManageButton(props: ComponentProps<typeof LinearSetupWizard>) {
  const [isOpen, setIsOpen] = useState(false)
  useQuery(workspaceSourcesOptions(orgSlug, docsWorkspace.slug))
  return (
    <>
      <Button onPress={() => setIsOpen(true)}>Manage</Button>
      <LinearSetupWizard {...props} isOpen={isOpen} onOpenChange={setIsOpen} />
    </>
  )
}

/**
 * A merge changes the scope while the dialog is closed. Manage then starts
 * from the new scope, not from the scope of the first open.
 */
export const ManageAgainShowsTheNewScope: Story = {
  render: (args) => <ManageButton {...args} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          oauthAppHandler({
            globalLinearOauthConfigured: true,
            oauthAppSaved: false,
          }),
          statusHandler(baseStatus),
          workspaceListHandler([docsWorkspace]),
          linearAvailableScopesHandler(),
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: docsWorkspace.slug,
              workspaceName: docsWorkspace.displayName,
              sources: [
                {
                  path: "linear-3",
                  provider: "linear",
                  status: "ok",
                  scopeSummary: "1 Linear team",
                },
              ],
            }),
          ]),
          http.get(`/${orgSlug}/api/v1/workspaces/docs/sources`, () =>
            HttpResponse.json(
              workspaceSourceList({
                items: [
                  workspaceSourceFixture({
                    path: "linear-3",
                    provider: "linear",
                    connectionId,
                    scope: { teams: currentTeams },
                  }),
                ],
              }),
            ),
          ),
        ],
      },
    },
  },
  beforeEach: () => {
    currentTeams = ["ENG"]
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(await body.findByRole("button", { name: "Manage" }))
    await expect(
      await body.findByRole("checkbox", { name: /Engineering/ }),
    ).toBeChecked()
    await userEvent.click(body.getByRole("button", { name: "Close" }))
    await waitFor(() =>
      expect(
        body.queryByRole("checkbox", { name: /Engineering/ }),
      ).not.toBeInTheDocument(),
    )

    currentTeams = ["OPS"]
    await userEvent.click(body.getByRole("button", { name: "Manage" }))
    await expect(
      await body.findByRole("checkbox", { name: /Operations/ }),
    ).toBeChecked()
    await expect(
      body.getByRole("checkbox", { name: /Engineering/ }),
    ).not.toBeChecked()
    await expect(
      body.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled()
  },
}
