import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionSyncHandler,
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  docsWorkspace,
  readOnlyWorkspace,
} from "../workspaces/workspace-fixtures"
import { CHOOSE_WORKSPACES_HINT } from "./ChooseWorkspacesStep"
import { ConnectorUsedIn } from "./ConnectorUsedIn"

const meta = {
  title: "Components/WorkspaceSources/ConnectorUsedIn",
  component: ConnectorUsedIn,
  decorators: [
    (Story) => (
      <div className="max-w-xl bg-zinc-950 p-4">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    connectionId: "con_story1",
    provider: "github",
  },
} satisfies Meta<typeof ConnectorUsedIn>

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  parameters: {
    msw: { handlers: { page: [connectionUsageHandler("loading")] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByRole("list", { name: "Loading Workspaces" }),
    ).toHaveAttribute("aria-busy", "true")
  },
}

export const NotUsedInAnyWorkspace: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          connectionUsageHandler([]),
          workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("No Workspaces yet")
    await expect(
      canvas.getByText(
        "Nothing syncs from GitHub until you add it to a Workspace.",
      ),
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Add to a Workspace" }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await dialog.findByRole("heading", { name: "Add GitHub to Workspaces" })
    await dialog.findByRole("checkbox", { name: docsWorkspace.displayName })
    await waitFor(() =>
      expect(dialog.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible(),
    )
  },
}

export const UsedInOneWorkspace: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
              stat: "5 linked repositories",
            }),
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", {
      name: "Docs · 5 linked repositories",
    })
    await expect(link).toBeVisible()
    await expect(canvas.queryByText("No Workspaces yet")).toBeNull()
    // GitHub sources read the repositories as they are: nothing to sync.
    await expect(canvas.queryByRole("button", { name: "Sync now" })).toBeNull()
  },
}

export const UsedInManyWorkspaces: Story = {
  args: { provider: "confluence" },
  parameters: {
    msw: {
      handlers: {
        page: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
              stat: "3 Confluence spaces",
            }),
            connectionUsageItem({
              workspaceSlug: "handbook",
              workspaceName: "Handbook",
              stat: "1 Confluence space",
            }),
            connectionUsageItem({
              workspaceSlug: "support",
              workspaceName: "Support",
              stat: "12 Confluence spaces",
            }),
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("link", { name: "Docs · 3 Confluence spaces" })
    const section = canvas.getByRole("region", { name: "Used in" })
    await expect(within(section).getAllByRole("link")).toHaveLength(3)
  },
}

export const UsedInLinksToSourceSection: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
              stat: "5 linked repositories",
            }),
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", {
      name: "Docs · 5 linked repositories",
    })
    await expect(link).toHaveAttribute(
      "href",
      "/acme/ws/docs?pane=settings#source-github",
    )
  },
}

const syncRequests: string[] = []
const onCallUsage = connectionUsageHandler([
  connectionUsageItem({
    workspaceSlug: "on-call",
    workspaceName: "On call",
    stat: "2 PagerDuty services",
  }),
])

export const SyncNow: Story = {
  args: { provider: "pagerduty" },
  parameters: {
    msw: {
      handlers: {
        page: [
          onCallUsage,
          connectionSyncHandler({ delayMs: 400, requests: syncRequests }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    syncRequests.length = 0
    const canvas = within(canvasElement)
    const button = await canvas.findByRole("button", { name: "Sync now" })
    await userEvent.click(button)
    await waitFor(() => expect(button).toHaveAttribute("data-pending", "true"))
    // A second click while the sync starts sends no second request.
    await userEvent.click(button)
    await expect(
      await canvas.findByText("Sync started. Files update after it ends."),
    ).toBeVisible()
    await expect(button).not.toHaveAttribute("data-pending")
    await expect(syncRequests).toHaveLength(1)
    await expect(syncRequests[0]).toMatch(/\/connectors\/con_story1\/sync$/)
  },
}

export const SyncNowFails: Story = {
  args: { provider: "pagerduty" },
  parameters: {
    msw: {
      handlers: {
        page: [onCallUsage, connectionSyncHandler({ status: 404 })],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Sync now" }),
    )
    await expect(
      await canvas.findByText("Could not start the sync."),
    ).toBeVisible()
  },
}
