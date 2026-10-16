import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import {
  activeMemberRoleHandler,
  connectionSyncHandler,
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
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
      <div className="w-full max-w-xl">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  args: {
    orgSlug,
    connectionId,
    onOpenWizard,
  },
  parameters: {
    msw: {
      handlers: {
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
  },
} satisfies Meta<typeof LinearConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

export const Checking: Story = {
  parameters: {
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
    await userEvent.click(canvas.getByRole("button", { name: "Expand Linear" }))
    await canvas.findByText("No Workspaces yet")
    await expect(
      canvas.getByText(
        "Nothing syncs from Linear until you add it to a Workspace.",
      ),
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Add to a Workspace" }),
    ).toBeVisible()
    // The Linear workspace is the account, not a ctx| Workspace.
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
    msw: {
      handlers: {
        page: [
          statusHandler(connected),
          activeMemberRoleHandler("admin"),
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
    msw: {
      handlers: {
        page: [
          statusHandler(connected),
          activeMemberRoleHandler("owner"),
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
    msw: {
      handlers: {
        page: [statusHandler(connected), activeMemberRoleHandler("member")],
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
        page: [statusHandler(connected), activeMemberRoleHandler("admin")],
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
