import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { linearOauthAppHandler } from "@/mocks/linear-handlers"
import {
  activeMemberRoleHandler,
  connectionSyncHandler,
  connectionUsageHandler,
  connectionUsageItem,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import {
  pendingSetupHandlers,
  playPendingSetup,
} from "../mocks/pending-setup-stories"
import type { LinearConnectorStatus } from "../queries/linear-connector"
import { LinearConnectionCard } from "./LinearConnectionCard"

const orgSlug = "acme"
const connectionId = "linear_story"

const connected: LinearConnectorStatus = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme Product",
}

function statusHandler(status: LinearConnectorStatus) {
  return http.get(`/${orgSlug}/api/v1/connectors/linear/status`, () =>
    HttpResponse.json(status),
  )
}

const onOpenWizard = fn()

const meta = {
  title: "Components/Connections/Linear/ConnectionCard",
  component: LinearConnectionCard,
  decorators: [
    (Story) => (
      <div className="w-xl max-w-full">
        <Story />
      </div>
    ),
  ],
  args: {
    orgSlug,
    connectionId,
    onOpenWizard,
  },
  parameters: {
    app: "root",
    msw: {
      handlers: {
        session: signedInHandlers,
        role: [activeMemberRoleHandler("admin")],
        pendingUpgrades: [pendingWorkspaceUpgradesHandler({})],
        oauthApp: [linearOauthAppHandler()],
        // The Docs Workspace has the Linear source of the usage below.
        sources: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                workspaceSourceFixture({
                  path: "sources/linear/eng.md",
                  provider: "linear",
                  connectionId,
                  connectionName: "Acme Product",
                  scopeSummary: "1 Linear team",
                }),
              ],
            }),
          ),
        ],
        usage: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
              sources: [
                {
                  path: "sources/linear/eng.md",
                  provider: "linear",
                  status: "ok",
                  scopeSummary: "1 Linear team",
                },
              ],
            }),
          ]),
        ],
      },
    },
    layout: "centered",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
} satisfies Meta<typeof LinearConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

export const Checking: Story = {
  parameters: {
    review: {
      purpose:
        "Linear connection card on the Connectors page: the status request has not returned, so the card is still checking.",
    },
    msw: {
      handlers: {
        page: [
          http.get(`/${orgSlug}/api/v1/connectors/linear/status`, async () => {
            await delay("infinite")
            return HttpResponse.json(connected)
          }),
        ],
      },
    },
  },
}

export const CouldntLoad: Story = {
  parameters: {
    review: {
      purpose:
        "Linear connection card on the Connectors page: the status request failed, so the card could not load.",
    },
    msw: {
      handlers: {
        page: [
          http.get(
            `/${orgSlug}/api/v1/connectors/linear/status`,
            () => new HttpResponse(null, { status: 500 }),
          ),
        ],
      },
    },
  },
}

const statusReads = fn()
const deleted = fn()

export const PendingSetup: Story = {
  parameters: {
    review: {
      purpose:
        "Linear connection card on the Connectors page: Linear is not installed yet, so setup is not finished.",
    },
    msw: {
      handlers: {
        page: [
          ...pendingSetupHandlers({
            orgSlug,
            provider: "linear",
            statusReads,
            deleted,
          }),
          statusHandler({
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
          }),
        ],
      },
    },
  },
  play: ({ canvasElement }) =>
    playPendingSetup({
      canvasElement,
      name: "Linear",
      onOpen: onOpenWizard,
      statusReads,
      deleted,
    }),
}

/** An installed connection: no setup action; "Used in" adds it to Workspaces. */
export const Connected: Story = {
  parameters: {
    review: {
      purpose:
        "Linear connection card on the Connectors page: Linear is installed and one Workspace uses it.",
    },
    msw: { handlers: { page: [statusHandler(connected)] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Connected")
    await expect(canvas.queryByText("Setup not finished")).toBeNull()
    await expect(
      canvas.queryByRole("button", { name: "Connect Linear" }),
    ).toBeNull()
  },
}

/** Connected, but no Workspace uses it yet, so nothing syncs. */
export const ConnectedNotInAWorkspace: Story = {
  parameters: {
    review: {
      purpose:
        "Linear connection card on the Connectors page: connected but in no Workspace, the card is open and says that nothing syncs yet.",
    },
    msw: {
      handlers: {
        usage: [connectionUsageHandler([])],
        page: [statusHandler(connected)],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Connected")
    await userEvent.click(canvas.getByRole("button", { name: "Linear" }))
    await canvas.findByText("No Workspaces yet")
    await expect(
      canvas.getByText(
        "Nothing syncs from Linear until you add it to a Workspace.",
      ),
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Add to a Workspace" }),
    ).toBeVisible()
    // The Linear workspace is the account, not a ctxpipe Workspace.
    await expect(canvas.getByText("Account")).toBeVisible()
    await expect(canvas.getByText("Acme Product")).toBeVisible()
  },
}

const syncRequests: string[] = []

async function openActionsMenu(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await canvas.findByText("Docs")
  await userEvent.click(
    canvas.getByRole("button", { name: "Linear connector actions" }),
  )
  return within(document.body)
}

/** An admin starts a sync from the actions menu; a toast confirms it. */
export const SyncNowFromMenu: Story = {
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  parameters: {
    review: {
      purpose:
        "Linear connection card on the Connectors page: an admin starts a sync from the actions menu and a toast confirms it.",
    },
    msw: {
      handlers: {
        role: [activeMemberRoleHandler("admin")],
        page: [
          statusHandler(connected),
          connectionSyncHandler({ requests: syncRequests }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    syncRequests.length = 0
    const body = await openActionsMenu(canvasElement)
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Sync now" }),
    )
    // The toast text is in the page before its entry motion ends.
    await body.findByText("Sync started. Files update after it ends.")
    await waitFor(() => expect(syncRequests).toHaveLength(1))
    await expect(syncRequests[0]).toMatch(/\/connectors\/linear_story\/sync$/)
  },
}

export const SyncNowFails: Story = {
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  parameters: {
    review: {
      purpose:
        "Linear connection card on the Connectors page: an owner starts a sync from the actions menu and an error toast says it could not start.",
    },
    msw: {
      handlers: {
        role: [activeMemberRoleHandler("owner")],
        page: [
          statusHandler(connected),
          connectionSyncHandler({ status: 404 }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = await openActionsMenu(canvasElement)
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Sync now" }),
    )
    // The toast text is in the page before its entry motion ends.
    await body.findByText("Could not start the sync. Try again.")
  },
}

/** Only an org admin or owner can start a sync. */
export const SyncNowHiddenForMember: Story = {
  parameters: {
    review: {
      purpose:
        "Linear card on the Connectors page: a member who is not an admin opens the actions menu, which holds only Remove connector because Sync now is for admins.",
    },
    msw: {
      handlers: {
        role: [activeMemberRoleHandler("member")],
        page: [statusHandler(connected)],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = await openActionsMenu(canvasElement)
    await body.findByRole("menuitem", { name: "Remove connector" })
    await expect(body.queryByRole("menuitem", { name: "Sync now" })).toBeNull()
  },
}

/**
 * A Workspace with only an open source pull request has nothing to sync
 * yet: the sync starts after the merge.
 */
export const SyncNowHiddenWhileAwaitingMerge: Story = {
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as SyncNowHiddenForMember.",
    },
    review: {
      purpose:
        "Linear connection card on the Connectors page: the only Workspace waits on a pull request merge, so the actions menu has no Sync now item.",
    },
    msw: {
      handlers: {
        usage: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
              stat: "",
              pendingChanges: [
                {
                  path: "sources/linear/eng.md",
                  provider: "linear",
                  action: "add",
                  pullRequestUrl: "https://github.com/acme/docs/pull/7",
                  createdAt: "2026-10-13T10:00:00Z",
                },
              ],
            }),
          ]),
        ],
        role: [activeMemberRoleHandler("admin")],
        page: [statusHandler(connected)],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = await openActionsMenu(canvasElement)
    await body.findByRole("menuitem", { name: "Remove connector" })
    await expect(body.queryByRole("menuitem", { name: "Sync now" })).toBeNull()
  },
}

export const Revoked: Story = {
  parameters: {
    review: {
      purpose:
        "Linear connection card on the Connectors page: a live connection whose access was revoked, so it needs a reconnect.",
    },
    msw: {
      handlers: {
        page: [
          statusHandler({
            ...connected,
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
    expect(canvas.queryByRole("button", { name: /^Remove/ })).toBeNull()
    expect(
      canvas.getByRole("button", { name: "Linear connector actions" }),
    ).toBeVisible()
  },
}

export const RevokedDraft: Story = {
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Revoked." },
    review: {
      purpose:
        "Linear connection card on the Connectors page: access was revoked on a connection that is not installed, and the card shows needs reconnect, not setup not finished.",
    },
    msw: {
      handlers: {
        page: [
          statusHandler({
            isInstalled: false,
            installationStatus: "revoked",
            workspaceName: "Acme Product",
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Needs reconnect")
    expect(canvas.queryByText("Setup not finished")).toBeNull()
    expect(canvas.queryByRole("button", { name: /^Remove/ })).toBeNull()
    expect(
      canvas.getByRole("button", { name: "Linear connector actions" }),
    ).toBeVisible()
  },
}
