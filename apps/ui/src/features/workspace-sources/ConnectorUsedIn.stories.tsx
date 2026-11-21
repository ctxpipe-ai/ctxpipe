import { expect, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import {
  docsWorkspace,
  readOnlyWorkspace,
} from "../workspaces/workspace-fixtures"
import { CHOOSE_WORKSPACES_HINT } from "./ChooseWorkspacesStep"
import { ConnectorUsedIn } from "./ConnectorUsedIn"

const meta = preview.meta({
  title: "Components/WorkspaceSources/ConnectorUsedIn",
  component: ConnectorUsedIn,
  decorators: [
    (Story) => (
      <div className="max-w-xl bg-zinc-950 p-4">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, pendingWorkspaceUpgradesHandler({}))
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
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
})

/**
 * Used in section of a connector, which lists the Workspaces that use the
 * connection: the Workspace list still loads.
 */
export const Loading = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("list", { name: "Loading Workspaces" }),
      ).toHaveAttribute("aria-busy", "true"),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(connectionUsageHandler("loading"))
  },
})

/**
 * Used in section of a connector, which lists the Workspaces that use the
 * connection: no Workspace uses the GitHub connection yet, and the Add to
 * Workspaces dialog is open.
 */
export const NotUsedInAnyWorkspace = meta.story({
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
  beforeEach: ({ msw }) => {
    msw.use(
      connectionUsageHandler([]),
      workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
    )
  },
})

/**
 * Used in section of a connector, which lists the Workspaces that use the
 * connection: one Workspace uses the GitHub connection, with its count of
 * linked repositories.
 */
export const UsedInOneWorkspace = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", {
      name: "Docs · 5 linked repositories",
    })
    await expect(link).toBeVisible()
    await expect(canvas.queryByText("No Workspaces yet")).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      connectionUsageHandler([
        connectionUsageItem({
          workspaceSlug: "docs",
          workspaceName: "Docs",
          stat: "5 linked repositories",
        }),
      ]),
    )
  },
})

/**
 * Used in section of a connector, which lists the Workspaces that use the
 * connection: two Workspaces have an open pull request for the Notion source
 * that waits for a merge.
 */
export const PullRequestAwaitingMerge = meta.story({
  args: { provider: "notion" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // A Workspace with only an open pull request is a waiting step, not
    // "No Workspaces yet", so the user does not add the source again.
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: "Docs" })).toBeVisible(),
    )
    await expect(canvas.queryByText("No Workspaces yet")).toBeNull()
    await expect(
      canvas.getByText("Pull request open. The sync starts after the merge."),
    ).toBeVisible()
    await expect(
      canvas.getByText(
        "Pull request open. The change applies after the merge.",
      ),
    ).toBeVisible()
    const pulls = canvas.getAllByRole("link", { name: "Open pull request" })
    await expect(pulls.map((pull) => pull.getAttribute("href"))).toEqual([
      "https://github.com/acme/docs/pull/7",
      "https://github.com/acme/ops/pull/3",
    ])
  },
  beforeEach: ({ msw }) => {
    msw.use(
      connectionUsageHandler([
        connectionUsageItem({
          workspaceSlug: "docs",
          workspaceName: "Docs",
          stat: "",
          pendingChanges: [
            {
              path: "notion",
              provider: "notion",
              action: "add",
              pullRequestUrl: "https://github.com/acme/docs/pull/7",
              createdAt: "2026-10-13T10:00:00Z",
            },
          ],
        }),
        connectionUsageItem({
          workspaceSlug: "ops",
          workspaceName: "Ops",
          stat: "2 Notion pages",
          pendingChanges: [
            {
              path: "runbooks",
              provider: "notion",
              action: "edit",
              pullRequestUrl: "https://github.com/acme/ops/pull/3",
              createdAt: "2026-10-13T10:00:00Z",
            },
          ],
        }),
      ]),
    )
  },
})

/**
 * Used in list of a Confluence connection card on the Connectors page: three
 * Workspaces use the connection, and each row links to the Workspace with the
 * count of spaces that it syncs.
 */
export const UsedInManyWorkspaces = meta.story({
  args: { provider: "confluence" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("link", { name: "Docs · 3 Confluence spaces" })
    const section = canvas.getByRole("region", { name: "Used in" })
    await expect(within(section).getAllByRole("link")).toHaveLength(3)
  },
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
  },
})

/**
 * Used in section of a connector, which lists the Workspaces that use the
 * connection: one Workspace uses the GitHub connection, and its link opens the
 * source section of its settings.
 */
export const UsedInLinksToSourceSection = meta.story({
  tags: ["required"],
  beforeEach: ({ msw }) => {
    msw.use(
      connectionUsageHandler([
        connectionUsageItem({
          workspaceSlug: "docs",
          workspaceName: "Docs",
          stat: "5 linked repositories",
        }),
      ]),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as UsedInOneWorkspace.",
    },
    intent:
      "Catches a connector usage row that links to the wrong place. The link must open the workspace settings pane at the source section of that connector. Not for usage counts.",
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
})
