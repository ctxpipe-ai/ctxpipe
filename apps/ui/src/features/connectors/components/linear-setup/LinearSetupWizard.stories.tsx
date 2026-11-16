import type { Meta, StoryObj } from "@storybook/react-vite"
import { useQuery } from "@tanstack/react-query"
import { delay, HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { Button } from "@/components/ui/Button"
import { CHOOSE_WORKSPACES_HINT } from "@/features/workspace-sources/ChooseWorkspacesStep"
import { workspaceSourcesOptions } from "@/features/workspace-sources/queries"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { signedInHandlers } from "@/mocks/handlers"
import {
  linearAvailableScopesHandler,
  linearOauthAppHandler,
} from "@/mocks/linear-handlers"
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

const meta = {
  title: "Components/Connections/Linear/SetupWizard",
  component: LinearSetupWizard,
  args: {
    orgSlug,
    connectionId,
    isOpen: true,
    onOpenChange: fn(),
    onConnectionIdChange: fn(),
  },
  parameters: {
    msw: {
      handlers: {
        session: signedInHandlers,
        pendingUpgrades: [pendingWorkspaceUpgradesHandler({})],
      },
    },
    app: "root",
    review: { kind: "component" },
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
    review: {
      purpose:
        "Linear setup wizard, which connects Linear and adds its teams to Workspaces: the status request is still loading.",
    },
    msw: {
      handlers: {
        page: [
          http.get(`/${orgSlug}/api/v1/connectors/linear/status`, async () => {
            await delay("infinite")
            return HttpResponse.json(baseStatus)
          }),
          linearOauthAppHandler(),
        ],
      },
    },
  },
}

export const ConnectWorkspace: Story = {
  args: { connectionId: undefined },
  parameters: {
    review: {
      purpose:
        "Linear setup wizard for a new connection on the hosted product, where ctxpipe supplies the OAuth app: the first step, which connects a Linear workspace.",
    },
    msw: {
      handlers: {
        page: [
          linearOauthAppHandler({
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
    review: {
      purpose:
        "Linear setup wizard on a self-hosted install: the step where the admin registers a private Linear OAuth app, with no app saved yet.",
    },
    msw: {
      handlers: {
        page: [
          linearOauthAppHandler({
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
    review: {
      purpose:
        "Linear setup wizard on a self-hosted install: the private Linear OAuth app is saved and the admin can connect Linear.",
    },
    msw: {
      handlers: {
        page: [
          linearOauthAppHandler({
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
    review: {
      purpose:
        "Linear setup wizard after the OAuth grant: the admin adds a Linear team to a Workspace, and the wizard moves to the merge step.",
    },
    msw: {
      handlers: {
        page: [
          linearOauthAppHandler({
            globalLinearOauthConfigured: true,
            oauthAppSaved: false,
          }),
          statusHandler(baseStatus),
          workspaceListHandler([docsWorkspace]),
          linearAvailableScopesHandler(),
          connectionUsageHandler([]),
          ...workspaceSourceAddHandlers(addCalls),
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
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Merge the pull request" }),
      ).toBeVisible(),
    )
    await expect(
      body.getByRole("link", { name: /^acme\/docs#7/ }),
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
    review: {
      purpose:
        "Linear setup wizard at the merge step: the admin merges the pull request on GitHub, and the step changes to Pull request merged.",
    },
    msw: {
      handlers: {
        page: [
          linearOauthAppHandler({
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
              path: "sources/linear/linear.md",
              pullRequestUrl,
            }),
          ),
          http.get(`/${orgSlug}/api/v1/workspaces/docs/sources`, () =>
            HttpResponse.json(
              merged
                ? workspaceSourceList({
                    items: [
                      workspaceSourceFixture({
                        path: "sources/linear/linear.md",
                        provider: "linear",
                        connectionId,
                        scope: { teams: ["ENG"] },
                      }),
                    ],
                  })
                : workspaceSourceList({
                    pendingChanges: [
                      {
                        path: "sources/linear/linear.md",
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
    await waitFor(() =>
      expect(
        body.getByRole("heading", { name: "Merge the pull request" }),
      ).toBeVisible(),
    )

    merged = true
    await waitFor(
      () =>
        expect(
          body.getByRole("heading", { name: "Pull request merged" }),
        ).toBeVisible(),
      { timeout: 10_000 },
    )
    await expect(body.getByText("Merged")).toBeVisible()
    await expect(
      body.getByRole("link", { name: /^acme\/docs#7/ }),
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
    visual: {
      skip: "Behavior test: it ends in the same state as ChooseWorkspaces.",
    },
    review: {
      purpose:
        "Linear setup wizard opened from Manage: it starts with the current Workspace and team checked, and the admin saves one more team.",
    },
    msw: {
      handlers: {
        page: [
          linearOauthAppHandler({
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
                  path: "sources/linear/linear-3.md",
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
                  path: "sources/linear/linear-3.md",
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
    await waitFor(() =>
      expect(
        body.getByRole("checkbox", { name: docsWorkspace.displayName }),
      ).toBeChecked(),
    )
    await waitFor(() =>
      expect(body.getByRole("checkbox", { name: /Engineering/ })).toBeChecked(),
    )
    const save = body.getByRole("button", { name: "Save changes" })
    await expect(save).toBeDisabled()
    await userEvent.click(body.getByRole("checkbox", { name: /Operations/ }))
    await userEvent.click(save)
    await waitFor(() => expect(manageCalls).toHaveLength(1))
    await expect(manageCalls[0]).toMatchObject({
      method: "PUT",
      path: `/${orgSlug}/api/v1/workspaces/${docsWorkspace.slug}/sources`,
      body: {
        path: "sources/linear/linear-3.md",
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
  // The close fade and the open fade of the dialog overlap on a slow runner,
  // and the step then keeps the scope of the first open. Reduced motion
  // removes the fades, so the dialog unmounts at once.
  tags: ["reduced-motion"],
  render: (args) => <ManageButton {...args} />,
  parameters: {
    review: {
      purpose:
        "Linear setup wizard opened from Manage a second time: it shows the teams after a merge, not the teams of the first open.",
    },
    msw: {
      handlers: {
        page: [
          linearOauthAppHandler({
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
                  path: "sources/linear/linear-3.md",
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
                    path: "sources/linear/linear-3.md",
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
    await waitFor(() =>
      expect(body.getByRole("checkbox", { name: /Engineering/ })).toBeChecked(),
    )
    await userEvent.click(body.getByRole("button", { name: "Close" }))
    await waitFor(() =>
      expect(
        body.queryByRole("checkbox", { name: /Engineering/ }),
      ).not.toBeInTheDocument(),
    )

    currentTeams = ["OPS"]
    // The open dialog hides the page from the accessibility tree, so this
    // finds Manage only after the dialog has unmounted. A new dialog then
    // starts from a new read.
    await userEvent.click(await body.findByRole("button", { name: "Manage" }))
    await waitFor(() =>
      expect(body.getByRole("checkbox", { name: /Operations/ })).toBeChecked(),
    )
    await waitFor(() =>
      expect(
        body.getByRole("checkbox", { name: /Engineering/ }),
      ).not.toBeChecked(),
    )
    await waitFor(() =>
      expect(body.getByRole("button", { name: "Save changes" })).toBeDisabled(),
    )
  },
}
