import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
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
    await waitFor(() =>
      expect(
        canvas.getByRole("list", { name: "Loading Workspaces" }),
      ).toHaveAttribute("aria-busy", "true"),
    )
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
  },
}

/**
 * The first source pull request waits for its merge, and no Workspace syncs
 * yet. "Used in" asks for the merge, with one teal link to the pull request.
 */
export const AwaitingFirstMerge: Story = {
  args: { provider: "notion" },
  parameters: {
    msw: {
      handlers: {
        page: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
              stat: "",
              pendingChanges: [
                {
                  path: "sources/notion/notion.md",
                  provider: "notion",
                  action: "add",
                  pullRequestUrl: "https://github.com/acme/docs/pull/7",
                  createdAt: "2026-10-13T10:00:00Z",
                },
              ],
            }),
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Merge the pull request")).toBeVisible(),
    )
    await expect(
      canvas.getByText(
        "ctxpipe opened a pull request that adds Notion to the Workspace. The sync starts after the merge.",
      ),
    ).toBeVisible()
    // One teal action: the pull request. The Workspace row does not repeat it.
    const reviews = canvas.getAllByRole("link", { name: /^Review/ })
    await expect(reviews).toHaveLength(1)
    await expect(reviews[0]).toHaveAccessibleName(
      "Review pull request. Opens GitHub in a new tab.",
    )
    await expect(reviews[0]).toHaveAttribute(
      "href",
      "https://github.com/acme/docs/pull/7",
    )
    await expect(canvas.getByRole("link", { name: "Docs" })).toBeVisible()
    await expect(canvas.queryByText("No Workspaces yet")).toBeNull()
    await expect(
      canvas.queryByText("Pull request open. The sync starts after the merge."),
    ).toBeNull()
  },
}

/** Two Workspaces wait for their first merge: one link for each pull request. */
export const AwaitingFirstMergeInTwoWorkspaces: Story = {
  args: { provider: "linear" },
  parameters: {
    msw: {
      handlers: {
        page: [
          connectionUsageHandler(
            ["docs", "ops"].map((slug, index) =>
              connectionUsageItem({
                workspaceSlug: slug,
                workspaceName: slug === "docs" ? "Docs" : "Ops",
                stat: "",
                pendingChanges: [
                  {
                    path: "sources/linear/linear.md",
                    provider: "linear",
                    action: "add",
                    pullRequestUrl: `https://github.com/acme/${slug}/pull/${index + 4}`,
                    createdAt: "2026-10-13T10:00:00Z",
                  },
                ],
              }),
            ),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Merge the pull requests")).toBeVisible(),
    )
    await expect(
      canvas.getByText(
        "ctxpipe opened a pull request in each Workspace that adds Linear. The sync starts after each merge.",
      ),
    ).toBeVisible()
    const reviews = canvas.getAllByRole("link", { name: /^Review/ })
    await expect(reviews.map((link) => link.textContent)).toEqual([
      "Review the Docs pull request",
      "Review the Ops pull request",
    ])
    await expect(reviews.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/acme/docs/pull/4",
      "https://github.com/acme/ops/pull/5",
    ])
  },
}

/**
 * A source syncs in one Workspace. Another Workspace waits for its first
 * merge, and an edit waits in the first one: each row links its pull request.
 */
export const PullRequestAwaitingMerge: Story = {
  args: { provider: "notion" },
  parameters: {
    msw: {
      handlers: {
        page: [
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
              sources: [
                {
                  path: "runbooks",
                  provider: "notion",
                  status: "ok",
                  scopeSummary: "2 Notion pages",
                },
              ],
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
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // A Workspace with only an open pull request is a waiting step, not
    // "No Workspaces yet", so the user does not add the source again.
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: "Docs" })).toBeVisible(),
    )
    await expect(canvas.queryByText("No Workspaces yet")).toBeNull()
    await expect(canvas.queryByText("Merge the pull request")).toBeNull()
    await expect(
      canvas.getByText("Pull request open. The sync starts after the merge."),
    ).toBeVisible()
    await expect(
      canvas.getByText(
        "Pull request open. The change applies after the merge.",
      ),
    ).toBeVisible()
    const pulls = canvas.getAllByRole("link", {
      name: "Review pull request. Opens GitHub in a new tab.",
    })
    await expect(pulls.map((pull) => pull.getAttribute("href"))).toEqual([
      "https://github.com/acme/docs/pull/7",
      "https://github.com/acme/ops/pull/3",
    ])
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
    intent:
      "Catches a connector usage row that links to the wrong place. The link must open the workspace settings pane at the source section of that connector. Not for usage counts.",
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
