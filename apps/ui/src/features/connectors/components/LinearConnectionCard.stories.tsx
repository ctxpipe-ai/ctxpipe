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
import preview from "../../../../.storybook/preview"
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

const meta = preview.meta({
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
  beforeEach: ({ msw }) => {
    msw.use(
      ...signedInHandlers,
      activeMemberRoleHandler("admin"),
      pendingWorkspaceUpgradesHandler({}),
      linearOauthAppHandler(),
      // The Docs Workspace has the Linear source of the usage below.
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
    )
  },
  parameters: {
    app: "root",
    layout: "centered",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
})

/**
 * Linear connection card on the Connectors page: the status request has not
 * returned, so the card is still checking.
 */
export const Checking = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(`/${orgSlug}/api/v1/connectors/linear/status`, async () => {
        await delay("infinite")
        return HttpResponse.json(connected)
      }),
    )
  },
})

/**
 * Linear connection card on the Connectors page: the status request failed, so
 * the card could not load.
 */
export const CouldntLoad = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        `/${orgSlug}/api/v1/connectors/linear/status`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    )
  },
})

const statusReads = fn()
const deleted = fn()

/**
 * Linear connection card on the Connectors page: Linear is not installed yet,
 * so setup is not finished.
 */
export const PendingSetup = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
  },
  play: ({ canvasElement }) =>
    playPendingSetup({
      canvasElement,
      name: "Linear",
      onOpen: onOpenWizard,
      statusReads,
      deleted,
    }),
})

/**
 * Linear connection card on the Connectors page: Linear is installed and one
 * Workspace uses it. The card has no setup action, and "Used in" adds the
 * connection to more Workspaces.
 */
export const Connected = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(statusHandler(connected))
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Connected")
    await expect(canvas.queryByText("Setup not finished")).toBeNull()
    await expect(
      canvas.queryByRole("button", { name: "Connect Linear" }),
    ).toBeNull()
  },
})

/**
 * Linear connection card on the Connectors page: Linear is connected but no
 * Workspace uses it yet. The card is open and says that nothing syncs yet.
 */
export const ConnectedNotInAWorkspace = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(connectionUsageHandler([]), statusHandler(connected))
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
})

const syncRequests: string[] = []

async function openActionsMenu(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await canvas.findByText("Docs")
  await userEvent.click(
    canvas.getByRole("button", { name: "Linear connector actions" }),
  )
  return within(document.body)
}

/**
 * Linear connection card on the Connectors page: an admin starts a sync with
 * Sync now in the actions menu, and a toast confirms it.
 */
export const SyncNowFromMenu = meta.story({
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("admin"),
      statusHandler(connected),
      connectionSyncHandler({ requests: syncRequests }),
    )
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
})

/**
 * Linear connection card on the Connectors page: an owner starts a sync from
 * the actions menu and an error toast says it could not start.
 */
export const SyncNowFails = meta.story({
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("owner"),
      statusHandler(connected),
      connectionSyncHandler({ status: 404 }),
    )
  },
  play: async ({ canvasElement }) => {
    const body = await openActionsMenu(canvasElement)
    await userEvent.click(
      await body.findByRole("menuitem", { name: "Sync now" }),
    )
    // The toast text is in the page before its entry motion ends.
    await body.findByText("Could not start the sync. Try again.")
  },
})

/**
 * Linear connection card on the Connectors page: a member who is not an admin
 * opens the actions menu. The menu holds only Remove connector, because only an
 * org admin or owner can start a sync.
 */
export const SyncNowHiddenForMember = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(activeMemberRoleHandler("member"), statusHandler(connected))
  },
  play: async ({ canvasElement }) => {
    const body = await openActionsMenu(canvasElement)
    await body.findByRole("menuitem", { name: "Remove connector" })
    await expect(body.queryByRole("menuitem", { name: "Sync now" })).toBeNull()
  },
})

/**
 * Linear connection card on the Connectors page: the only Workspace has only an
 * open source pull request, so the actions menu has no Sync now item. The sync
 * starts after the merge.
 */
export const SyncNowHiddenWhileAwaitingMerge = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
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
      activeMemberRoleHandler("admin"),
      statusHandler(connected),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as SyncNowHiddenForMember.",
    },
  },
  play: async ({ canvasElement }) => {
    const body = await openActionsMenu(canvasElement)
    await body.findByRole("menuitem", { name: "Remove connector" })
    await expect(body.queryByRole("menuitem", { name: "Sync now" })).toBeNull()
  },
})

/**
 * Linear connection card on the Connectors page: a live connection whose access
 * was revoked, so it needs a reconnect.
 */
export const Revoked = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      statusHandler({
        ...connected,
        isInstalled: false,
        installationStatus: "revoked",
      }),
    )
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
})

/**
 * Linear connection card on the Connectors page: access was revoked on a
 * connection that is not installed, and the card shows needs reconnect, not
 * setup not finished.
 */
export const RevokedDraft = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      statusHandler({
        isInstalled: false,
        installationStatus: "revoked",
        workspaceName: "Acme Product",
      }),
    )
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Revoked." },
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
})
