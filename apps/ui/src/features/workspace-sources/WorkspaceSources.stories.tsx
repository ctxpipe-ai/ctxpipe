import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { emptyLinkedWorkspaceDetail } from "@/features/workspaces/workspace-fixtures"
import { linearAvailableScopesHandler } from "@/mocks/linear-handlers"
import {
  githubInstallationReposHandler,
  workspaceDetailHandler,
} from "@/mocks/workspace-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
  workspaceSourceChangeHandlers,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import {
  upgradesFixture,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceSources } from "./WorkspaceSources"

const meta = {
  title: "Components/WorkspaceSources/Sources",
  component: WorkspaceSources,
  decorators: [
    (Story) => (
      <div className="h-[40rem] overflow-auto bg-zinc-950 p-4">
        <Story />
        <Toaster />
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
    // Only an owner or admin sees the pickers. A member story sets `role`.
    // The Add repositories dialog reads the Workspace and its format. A
    // story that needs another answer sets `detail` or `upgrades`.
    msw: {
      handlers: {
        role: [activeMemberRoleHandler("owner")],
        detail: [workspaceDetailHandler(emptyLinkedWorkspaceDetail)],
        upgrades: [
          workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
        ],
      },
    },
  },
  args: { orgSlug: "acme", workspaceSlug: "docs" },
} satisfies Meta<typeof WorkspaceSources>

export default meta

type Story = StoryObj<typeof meta>

type ChangeCall = { method: string; path: string; body: unknown }
const editCalls: ChangeCall[] = []
const addCalls: ChangeCall[] = []
const removeCalls: ChangeCall[] = []

const connected = orgConnectionsHandler([
  { id: "con_gh1", type: "github", displayName: "acme-gh" },
  { id: "con_cf1", type: "forge" },
  { id: "con_li1", type: "linear" },
])

const githubSource = workspaceSourceFixture({
  path: "sources/github/acme/api.md",
  provider: "github",
  connectionId: "con_gh1",
  connectionName: "acme-gh",
  scope: { repository: "acme/api" },
  scopeSummary: "acme/api",
  description: "The public API service. Its docs link here.",
})
const githubWebSource = workspaceSourceFixture({
  path: "sources/github/acme/web.md",
  provider: "github",
  connectionId: "con_gh1",
  connectionName: "acme-gh",
  scope: { repository: "acme/web" },
  scopeSummary: "acme/web",
})
const confluenceSource = workspaceSourceFixture({
  path: "sources/confluence/eng-docs.md",
  provider: "confluence",
  connectionId: "con_cf1",
  connectionName: "acme.atlassian.net",
  scopeSummary: "3 spaces",
})
const linearSource = workspaceSourceFixture({
  path: "sources/linear/eng-issues.md",
  provider: "linear",
  connectionId: "con_li1",
  connectionName: "Acme Linear",
  scope: { teams: ["ENG"] },
  scopeSummary: "1 team",
  description: "Engineering issues. Ingest them for the weekly review.",
})

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: { page: [workspaceSourcesHandler("loading"), connected] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Loading sources")
    await expect(canvas.queryByText(/No sources yet/)).toBeNull()
  },
}

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          orgConnectionsHandler([]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/No sources yet\. Connect a tool/)
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Sources" }),
    ).toBeInTheDocument()
    await expect(
      canvas.getByRole("link", { name: "Add connection" }),
    ).toHaveAttribute("href", "/acme/connectors")
    await expect(canvas.queryByText("Add another connection")).toBeNull()
    await expect(canvas.queryByText("sources/")).toBeNull()
  },
}

export const ConnectedWithoutSources: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [workspaceSourcesHandler(workspaceSourceList()), connected],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: "Add repositories" })
    await expect(canvas.getByText("No sources yet")).toBeVisible()
    await expect(canvas.getByText("No Linear sources yet")).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Add Confluence source" }),
    ).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Add Linear source" }),
    ).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Add another connection" }),
    ).toHaveAttribute("href", "/acme/connectors")
  },
}

export const SeveralProviders: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                githubSource,
                githubWebSource,
                confluenceSource,
                linearSource,
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("acme/api")
    await expect(canvas.getByText("4 sources from 3 connectors")).toBeVisible()
    await expect(canvas.getByText("sources/")).toBeVisible()
    // The description of a source file shows under its path.
    await expect(
      canvas.getByText(
        "Engineering issues. Ingest them for the weekly review.",
      ),
    ).toBeVisible()
    for (const [provider, heading, summary] of [
      ["github", "GitHub", "acme/web"],
      ["confluence", "Confluence", "3 spaces"],
      ["linear", "Linear", "1 team"],
    ]) {
      const section = canvasElement.querySelector<HTMLElement>(
        `#source-${provider}`,
      )
      await expect(section).not.toBeNull()
      if (!section) continue
      const group = within(section)
      await expect(group.getByRole("heading", { name: heading })).toBeVisible()
      await expect(group.getByText(summary)).toBeVisible()
    }
    await expect(
      canvas.getByRole("link", { name: "Add another connection" }),
    ).toBeVisible()
  },
}

export const OneProviderSeveralSources: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                linearSource,
                {
                  ...linearSource,
                  path: "sources/linear/ops-issues.md",
                  scopeSummary: "2 teams",
                },
                {
                  ...linearSource,
                  path: "sources/linear/labs-issues.md",
                  connectionId: "con_li2",
                  connectionName: "Labs Linear",
                  scopeSummary: "3 teams",
                },
              ],
            }),
          ),
          orgConnectionsHandler([
            { id: "con_li1", type: "linear" },
            { id: "con_li2", type: "linear" },
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("3 sources from 2 connectors")
    const section = canvasElement.querySelector<HTMLElement>("#source-linear")
    if (!section) throw new Error("Missing Linear group")
    const group = within(section)
    await expect(group.getByText("3 sources")).toBeVisible()
    await expect(group.getAllByRole("listitem")).toHaveLength(3)
    await expect(group.getByText("2 teams")).toBeVisible()
    await expect(
      group.getByRole("button", { name: "Edit sources/linear/labs-issues.md" }),
    ).toBeVisible()
    await expect(canvas.getAllByRole("heading", { level: 3 })).toHaveLength(1)
  },
}

const goneLinearSources = ["old-issues", "old-projects"].map((name) =>
  workspaceSourceFixture({
    path: `sources/linear/${name}.md`,
    provider: "linear",
    connectionId: "con_gone",
    connectionName: null,
    status: "connection_missing",
    statusDetail: "The connection con_gone does not exist",
    scopeSummary: "1 team",
  }),
)

/**
 * Two sources share one reason. The Linear header shows the reason once,
 * with the count, and the rows do not repeat it. A wide section shows the
 * table columns.
 */
export const SharedReasonShowsOnce: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [linearSource, ...goneLinearSources],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("3 sources from 1 connector · 2 need attention")
    const section = canvasElement.querySelector<HTMLElement>("#source-linear")
    if (!section) throw new Error("Missing Linear group")
    const group = within(section)
    await expect(
      group.getAllByText("The connection con_gone does not exist"),
    ).toHaveLength(1)
    await expect(group.getByText("· 2 sources")).toBeVisible()
    await expect(group.getAllByText("Connection missing")).toHaveLength(2)
    await expect(canvas.getByText("File", { exact: true })).toBeVisible()
  },
}

/**
 * In a narrow pane the table folds: no column header, and each row shows
 * its connection and key under the title.
 */
export const NarrowPaneFoldsTable: Story = {
  decorators: [
    (Story) => (
      <div className="w-[30rem]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({ items: [linearSource] }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("sources/linear/eng-issues.md")
    await expect(canvas.getByText("File", { exact: true })).not.toBeVisible()
    await expect(canvas.getByText("Acme Linear")).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Edit sources/linear/eng-issues.md" }),
    ).toBeVisible()
  },
}

export const NeedsAttention: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                githubSource,
                linearSource,
                workspaceSourceFixture({
                  path: "sources/linear/old-issues.md",
                  provider: "linear",
                  connectionId: "con_gone",
                  connectionName: null,
                  status: "connection_missing",
                  statusDetail: "The connection con_gone does not exist",
                  scopeSummary: "2 teams",
                }),
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("3 sources from 2 connectors · 1 needs attention")
    const section = canvasElement.querySelector<HTMLElement>("#source-linear")
    if (!section) throw new Error("Missing Linear group")
    const group = within(section)
    await expect(group.getByText("2 sources · 1 needs attention")).toBeVisible()
    await expect(group.getByText("Connection missing")).toBeVisible()
    await expect(
      group.getByText("The connection con_gone does not exist"),
    ).toBeVisible()
  },
}

export const PendingAdd: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              pendingChanges: [
                {
                  path: "sources/confluence/eng-docs.md",
                  provider: "confluence",
                  action: "add",
                  pullRequestUrl: "https://github.com/acme/docs/pull/5",
                  createdAt: "2026-10-10T10:00:00.000Z",
                },
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("No sources yet · 1 change awaiting merge")
    const section =
      canvasElement.querySelector<HTMLElement>("#source-confluence")
    if (!section) throw new Error("Missing Confluence group")
    const group = within(section)
    await expect(group.getByText("1 awaiting merge")).toBeVisible()
    await expect(group.getByText("New source")).toBeVisible()
    // "Awaiting merge" reads as a link: it names the pull request on GitHub,
    // and its icon shows that it leaves the app.
    const link = group.getByRole("link", {
      name: "Awaiting merge. Opens the pull request on GitHub in a new tab.",
    })
    await expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/docs/pull/5",
    )
    await expect(link).toHaveAttribute("target", "_blank")
    await expect(link.querySelector("svg")).not.toBeNull()
  },
}

export const EachStatus: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                confluenceSource,
                workspaceSourceFixture({
                  path: "sources/linear/bad-shape.md",
                  provider: "linear",
                  status: "invalid",
                  statusDetail: "teams: Expected an array",
                  scopeSummary: "Linear",
                }),
                workspaceSourceFixture({
                  path: "sources/linear/old-linear.md",
                  provider: "linear",
                  connectionId: "con_gone",
                  connectionName: null,
                  status: "connection_missing",
                  statusDetail: "The connection con_gone does not exist",
                  scopeSummary: "1 team",
                }),
                workspaceSourceFixture({
                  path: "sources/slack/eng-channels.md",
                  provider: "slack",
                  status: "ok",
                  statusDetail: "Channel #old is archived",
                  scopeSummary: "2 Slack channels",
                }),
                workspaceSourceFixture({
                  path: "sources/confluence/secret-space.md",
                  provider: "confluence",
                  status: "out_of_access",
                  statusDetail: "The connection cannot read the space SEC",
                  scopeSummary: "1 space",
                }),
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findAllByText("OK")
    await expect(canvas.getByText("Not valid")).toBeVisible()
    await expect(canvas.getByText("Connection missing")).toBeVisible()
    await expect(canvas.getByText("Out of access")).toBeVisible()
    await expect(canvas.getByText("teams: Expected an array")).toBeVisible()
    await expect(canvas.getByText(/No connection/)).toBeVisible()
    // An ok source that is usable in part names its bad channels.
    await expect(canvas.getByText("Channel #old is archived")).toBeVisible()
  },
}

export const AwaitingMerge: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [githubSource, linearSource],
              pendingChanges: [
                {
                  path: "sources/github/acme/api.md",
                  provider: "github",
                  action: "edit",
                  pullRequestUrl: "https://github.com/acme/docs/pull/3",
                  createdAt: "2026-10-10T10:00:00.000Z",
                },
                {
                  path: "sources/linear/eng-issues.md",
                  provider: "linear",
                  action: "remove",
                  pullRequestUrl: "https://github.com/acme/docs/pull/4",
                  createdAt: "2026-10-10T10:00:00.000Z",
                },
                {
                  path: "sources/confluence/eng-docs.md",
                  provider: "confluence",
                  action: "add",
                  pullRequestUrl: "https://github.com/acme/docs/pull/5",
                  createdAt: "2026-10-10T10:00:00.000Z",
                },
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const links = await canvas.findAllByRole("link", {
      name: /^Awaiting merge\./,
    })
    await expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/acme/docs/pull/3",
      "https://github.com/acme/docs/pull/5",
    ])
    await expect(
      canvas.getByRole("link", { name: /^Removal awaiting merge\./ }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/4")
    await expect(canvas.getByText("New source")).toBeVisible()
  },
}

export const ScrollsToSourceAnchor: Story = {
  tags: ["workspace-golden"],
  decorators: [
    (Story) => (
      <div data-scroll-root className="h-64 overflow-auto">
        <Story />
      </div>
    ),
  ],
  beforeEach: () => {
    window.history.replaceState(null, "", "#source-confluence")
    return () => window.history.replaceState(null, "", "#")
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                githubSource,
                { ...githubSource, path: "sources/github/acme/more-repos.md" },
                {
                  ...githubSource,
                  path: "sources/github/acme/even-more-repos.md",
                },
                confluenceSource,
                {
                  ...confluenceSource,
                  path: "sources/confluence/more-docs.md",
                },
                linearSource,
                { ...linearSource, path: "sources/linear/more-issues.md" },
                { ...linearSource, path: "sources/linear/even-more-issues.md" },
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findAllByText("1 team")
    const root = canvasElement.querySelector<HTMLElement>("[data-scroll-root]")
    const section =
      canvasElement.querySelector<HTMLElement>("#source-confluence")
    if (!root || !section) throw new Error("Missing scroll root or section")
    await waitFor(() => expect(root.scrollTop).toBeGreaterThan(0))
    await document.fonts.ready
    const offset =
      section.getBoundingClientRect().top - root.getBoundingClientRect().top
    await expect(Math.abs(offset)).toBeLessThan(40)
  },
}

export const EditSendsChange: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({ items: [linearSource] }),
          ),
          connected,
          linearAvailableScopesHandler(),
          ...workspaceSourceChangeHandlers(editCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    editCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Edit sources/linear/eng-issues.md",
      }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await dialog.findByRole("heading", { name: "Edit Linear source" })
    await waitFor(() =>
      expect(
        dialog.getByRole("checkbox", { name: /Engineering/ }),
      ).toBeChecked(),
    )
    await userEvent.click(dialog.getByRole("checkbox", { name: /Operations/ }))
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() => expect(editCalls).toHaveLength(1))
    await expect(editCalls[0]).toMatchObject({
      method: "PUT",
      path: "/acme/api/v1/workspaces/docs/sources",
      body: {
        path: "sources/linear/eng-issues.md",
        source: {
          provider: "linear",
          connectionId: "con_li1",
          scope: { teams: ["ENG", "OPS"] },
        },
      },
    })
    await within(document.body).findByText(/Pull request opened/)
  },
}

export const UnlinkSendsChange: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({ items: [githubSource] }),
          ),
          connected,
          ...workspaceSourceChangeHandlers(editCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    editCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Unlink acme/api" }),
    )
    await waitFor(() => expect(editCalls).toHaveLength(1))
    // One file holds one repository: an unlink deletes the file.
    await expect(editCalls[0]).toMatchObject({
      method: "DELETE",
      path: "/acme/api/v1/workspaces/docs/sources",
      query: {
        path: "sources/github/acme/api.md",
      },
    })
    await within(document.body).findByText(/Pull request opened/)
  },
}

/**
 * A repository from a legacy `.ctxpipe/sources.yaml` row has no file that a
 * delete can name: the row shows a note and no unlink button.
 */
export const LegacyYamlRowNotRemovable: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                workspaceSourceFixture({
                  path: "product-repos",
                  provider: "github",
                  connectionId: "con_gh1",
                  connectionName: "acme-gh",
                  scope: { repositories: ["acme/api"] },
                  scopeSummary: "1 linked repository",
                  removable: false,
                }),
                workspaceSourceFixture({
                  path: "eng-docs",
                  provider: "confluence",
                  connectionId: "con_cf1",
                  scopeSummary: "3 spaces",
                  removable: false,
                }),
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("acme/api")
    await expect(
      canvas.getByText(/Defined in \.ctxpipe\/sources\.yaml/),
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Unlink acme/api" }),
    ).toBeNull()
    await expect(
      canvas.getByText(/This row is not a source file/),
    ).toBeVisible()
    for (const action of ["Remove", "Edit", "Rename"])
      await expect(
        canvas.queryByRole("button", { name: `${action} eng-docs` }),
      ).toBeNull()
  },
}

const unlinkCalls: ChangeCall[] = []

/**
 * A linked repository with a source file: the unlink deletes the file. The
 * unlink command does not run too, because the file change covers it.
 */
export const UnlinkDeletesTheSourceFile: Story = {
  args: {
    linkedRepositories: [
      {
        id: "lnk_api",
        workspaceId: "ws_story1",
        gitUrl: "https://github.com/acme/api",
        desiredRef: null,
        desiredSha: "abc",
        indexedSha: "abc",
        createdAt: "2026-10-01T10:00:00.000Z",
      },
    ],
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                {
                  ...githubSource,
                  scope: { repository: "acme/api" },
                  scopeSummary: "acme/api",
                },
              ],
            }),
          ),
          connected,
          ...workspaceSourceChangeHandlers(unlinkCalls),
          http.delete(
            "*/api/v1/workspaces/:workspaceSlug/linked-repositories/:linkedId",
            ({ request }) => {
              unlinkCalls.push({
                method: "DELETE",
                path: new URL(request.url).pathname,
                body: null,
              })
              return HttpResponse.json({
                outcome: "pull_request",
                path: "sources/github/acme/api.md",
                pullRequestUrl: "https://github.com/acme/docs/pull/7",
              })
            },
          ),
        ],
      },
    },
  },
  beforeEach: () => {
    unlinkCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Unlink acme/api" }),
    )
    await waitFor(() => expect(unlinkCalls).toHaveLength(1))
    await expect(unlinkCalls).toEqual([
      expect.objectContaining({
        method: "DELETE",
        path: "/acme/api/v1/workspaces/docs/sources",
        query: expect.objectContaining({
          path: "sources/github/acme/api.md",
        }),
      }),
    ])
  },
}

export const LinkedRepositoryWithoutSourceShows: Story = {
  args: {
    linkedRepositories: [
      {
        id: "lnk_story1",
        workspaceId: "ws_story1",
        gitUrl: "https://github.com/acme/legacy.git",
        desiredRef: null,
        desiredSha: "abc",
        indexedSha: "abc",
        createdAt: "2026-10-01T10:00:00.000Z",
      },
    ],
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({ items: [githubSource] }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const list = within(
      await canvas.findByRole("list", { name: "GitHub repositories" }),
    )
    await expect(list.getAllByRole("listitem")).toHaveLength(2)
    await expect(list.getByText("acme/legacy")).toBeVisible()
    await expect(list.getByText("Indexed")).toBeVisible()
    await expect(list.getByText("Linked by a repositories file")).toBeVisible()
  },
}

export const AddSendsChange: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          githubInstallationReposHandler([
            {
              name: "api",
              clone_url: "https://github.com/acme/api.git",
              full_name: "acme/api",
            },
          ]),
          ...workspaceSourceChangeHandlers(addCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    addCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add repositories" }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await dialog.findByRole("heading", { name: "Add repositories" })
    const repo = await dialog.findByRole("checkbox", { name: "acme/api" })
    await expect(
      dialog.getByRole("button", { name: "Open a pull request" }),
    ).toBeDisabled()
    await userEvent.click(repo)
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() => expect(addCalls).toHaveLength(1))
    await expect(addCalls[0]).toMatchObject({
      method: "POST",
      path: "/acme/api/v1/workspaces/docs/sources",
      body: {
        source: {
          provider: "github",
          connectionId: "con_gh1",
          scope: { repository: "acme/api" },
        },
      },
    })
    // The toast keeps its action, which opens the pull request. The toast
    // renders in a portal, so query it from the document body.
    await within(canvasElement.ownerDocument.body).findByRole("button", {
      name: "View pull request",
    })
  },
}

/** Several repositories go to the server in one batch, so in one pull request. */
export const AddSeveralSendsOneBatch: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          githubInstallationReposHandler([
            {
              name: "api",
              clone_url: "https://github.com/acme/api.git",
              full_name: "acme/api",
            },
            {
              name: "web",
              clone_url: "https://github.com/acme/web.git",
              full_name: "acme/web",
            },
          ]),
          ...workspaceSourceChangeHandlers(addCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    addCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add repositories" }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await userEvent.click(
      await dialog.findByRole("checkbox", { name: "acme/api" }),
    )
    await userEvent.click(dialog.getByRole("checkbox", { name: "acme/web" }))
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    // Two repositories make one batch request, so one pull request.
    await waitFor(() => expect(addCalls).toHaveLength(1))
    await expect(addCalls[0]).toMatchObject({
      method: "POST",
      path: "/acme/api/v1/workspaces/docs/sources/batch",
      body: {
        sources: [
          { source: { scope: { repository: "acme/api" } } },
          { source: { scope: { repository: "acme/web" } } },
        ],
      },
    })
  },
}

export const RemoveSendsChange: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({ items: [confluenceSource] }),
          ),
          connected,
          ...workspaceSourceChangeHandlers(removeCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    removeCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Remove sources/confluence/eng-docs.md",
      }),
    )
    const dialog = within(await within(document.body).findByRole("alertdialog"))
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() => expect(removeCalls).toHaveLength(1))
    await expect(removeCalls[0]).toMatchObject({
      method: "DELETE",
      path: "/acme/api/v1/workspaces/docs/sources",
      query: { path: "sources/confluence/eng-docs.md" },
    })
  },
}
export const FileNotValid: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              fileError: "version: Expected 1",
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("The legacy sources file is not valid")
    await expect(canvas.getByText("version: Expected 1")).toBeVisible()
  },
}

export const RefusedRepositoryFile: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                linearSource,
                workspaceSourceFixture({
                  path: "old-entry",
                  provider: null,
                  connectionId: null,
                  connectionName: null,
                  status: "invalid",
                  statusDetail: "The provider is not known",
                  scopeSummary: "Unknown provider",
                }),
                workspaceSourceFixture({
                  path: "repositories/tools.md",
                  provider: null,
                  connectionId: null,
                  connectionName: null,
                  status: "invalid",
                  statusDetail:
                    "repositories/tools.md: ctx| links only GitHub repositories. Move the link into .ctxpipe/sources.yaml or remove the file.",
                  scopeSummary: "Repository file",
                  removable: false,
                }),
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The repository file shows its error, but a remove cannot name it.
    await waitFor(() =>
      expect(
        canvas.getByText(/repositories\/tools\.md: ctx\| links only GitHub/),
      ).toBeVisible(),
    )
    await expect(
      canvas.queryByRole("button", { name: "Remove repositories/tools.md" }),
    ).toBeNull()
    await expect(
      canvas.getByRole("button", { name: "Remove old-entry" }),
    ).toBeVisible()
  },
}

export const LoadFailed: Story = {
  parameters: {
    msw: {
      handlers: { page: [workspaceSourcesHandler("error"), connected] },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Could not load the sources of this Workspace.")
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
  },
}

export const ReadOnlyHidesChanges: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [githubSource, linearSource],
              canEdit: false,
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("acme/api")
    await expect(
      canvas.queryByRole("button", { name: "Add repositories" }),
    ).toBeNull()
    await expect(
      canvas.queryByRole("button", { name: "Unlink acme/api" }),
    ).toBeNull()
    await expect(
      canvas.queryByRole("button", {
        name: "Remove sources/linear/eng-issues.md",
      }),
    ).toBeNull()
  },
}

const pickerCalls: ChangeCall[] = []

/** Each GitHub connection lists its own repositories. */
const reposPerConnection = http.get(
  /\/github\/installation\/repositories$/,
  ({ request }) => {
    const connectionId = new URL(request.url).searchParams.get("connectionId")
    const name = connectionId === "con_gh2" ? "labs/tool" : "acme/api"
    return HttpResponse.json({
      repositories: [
        {
          id: 1,
          name: name.split("/")[1],
          full_name: name,
          clone_url: `https://github.com/${name}.git`,
        },
      ],
      repositorySelection: "selected",
      manageUrl: null,
      hasMore: false,
      totalCount: 1,
    })
  },
)

export const PickerShowsConnectionNames: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          orgConnectionsHandler([
            { id: "con_gh1", type: "github", displayName: "acme-gh" },
            { id: "con_gh2", type: "github", displayName: "acme-labs" },
          ]),
          reposPerConnection,
          ...workspaceSourceChangeHandlers(pickerCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    pickerCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add repositories" }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    // The picker lists the repositories of each GitHub connection.
    await userEvent.click(
      await dialog.findByRole("checkbox", { name: "acme/api" }),
    )
    await userEvent.click(dialog.getByRole("checkbox", { name: "labs/tool" }))
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    // Both repositories go in one batch request.
    await waitFor(() => expect(pickerCalls).toHaveLength(1))
    await expect(
      (
        pickerCalls[0]?.body as { sources: Array<{ source: unknown }> }
      ).sources.map((item) => item.source),
    ).toEqual(
      expect.arrayContaining([
        {
          provider: "github",
          connectionId: "con_gh1",
          scope: { repository: "acme/api" },
        },
        {
          provider: "github",
          connectionId: "con_gh2",
          scope: { repository: "labs/tool" },
        },
      ]),
    )
  },
}

/**
 * The GitHub group with no repositories yet: one primary "Add repositories"
 * button and a short line of text in the body (CTX-864).
 */
export const GithubNoRepositories: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [workspaceSourcesHandler(workspaceSourceList()), connected],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(
      "Add the code repositories of this Workspace. ctxpipe reads them to answer questions.",
    )
    const section = canvasElement.querySelector<HTMLElement>("#source-github")
    if (!section) throw new Error("Missing GitHub group")
    const group = within(section)
    await expect(group.getByText("No GitHub sources yet")).toBeVisible()
    await expect(group.queryByRole("searchbox")).toBeNull()
    // One add button, and it is the primary one.
    const [add, ...others] = group.getAllByRole("button", {
      name: "Add repositories",
    })
    await expect(others).toHaveLength(0)
    await expect(add).toHaveClass("bg-primary")
    await userEvent.click(add as HTMLElement)
    await within(document.body).findByRole("dialog", {
      name: "Add repositories",
    })
  },
}

/** The repositories of the GitHub App. The Workspace repository is acme/docs. */
const reposWithWorkspaceRepository = githubInstallationReposHandler([
  {
    id: 1,
    name: "Docs",
    // GitHub keeps the letter case; the stored Workspace URL is in lowercase.
    clone_url: "https://github.com/Acme/Docs.git",
    full_name: "Acme/Docs",
  },
  {
    id: 2,
    name: "api",
    clone_url: "https://github.com/acme/api.git",
    full_name: "acme/api",
  },
])

async function openAddRepositories(canvasElement: HTMLElement) {
  await userEvent.click(
    await within(canvasElement).findByRole("button", {
      name: "Add repositories",
    }),
  )
  return within(
    await within(document.body).findByRole("dialog", {
      name: "Add repositories",
    }),
  )
}

/**
 * The dialog says what ctxpipe does with a repository and what "Open a pull
 * request" does. Under the list, a hint links to the GitHub App access.
 */
export const AddRepositoriesExplains: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          reposWithWorkspaceRepository,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openAddRepositories(canvasElement)
    await dialog.findByText(
      "ctxpipe reads the default branch of each repository. It uses the code to answer questions and to keep this Workspace current.",
    )
    // The dialog fades in, so each visibility check waits.
    await waitFor(() =>
      expect(
        dialog.getByText(
          /Each repository becomes active when you merge the pull request that adds it\./,
        ),
      ).toBeVisible(),
    )
    await dialog.findByRole("checkbox", { name: "acme/api" })
    await waitFor(() =>
      expect(dialog.getByText(/Don't see a repository\?/)).toBeVisible(),
    )
    await expect(
      dialog.getByRole("link", { name: "Give ctxpipe access on GitHub" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/organizations/acme/settings/installations/123",
    )
  },
}

/** A search with no match: the hint shows the next step, not a dead end. */
export const AddRepositoriesEmptySearchHint: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          reposWithWorkspaceRepository,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openAddRepositories(canvasElement)
    await dialog.findByRole("checkbox", { name: "acme/api" })
    await userEvent.type(
      dialog.getByRole("searchbox", { name: "Search GitHub repositories" }),
      "billing",
    )
    await dialog.findByText("No repositories match that search.")
    await waitFor(() =>
      expect(
        dialog.getByRole("link", { name: "Give ctxpipe access on GitHub" }),
      ).toBeVisible(),
    )
  },
}

/**
 * The Workspace repository shows in the list, disabled, with a label. The
 * match ignores the letter case of the name.
 */
export const AddRepositoriesWorkspaceRepositoryDisabled: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          reposWithWorkspaceRepository,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openAddRepositories(canvasElement)
    const own = await dialog.findByRole("checkbox", { name: /Acme\/Docs/ })
    await waitFor(() => expect(own).toBeDisabled())
    await waitFor(() =>
      expect(dialog.getByText("This Workspace's repository")).toBeVisible(),
    )
    await waitFor(() =>
      expect(dialog.getByRole("checkbox", { name: "acme/api" })).toBeEnabled(),
    )
    await expect(
      dialog.getByRole("button", { name: "Open a pull request" }),
    ).toBeDisabled()
  },
}

const accessReads = { count: 0 }
const realDateNow = Date.now
/**
 * The user ticks a repository, gives access on GitHub in another tab, then
 * comes back: the list loads again, and the new repository is first in it.
 * The tick stays on the repository the user chose, and the pull request adds
 * that one. The query client here keeps data fresh for 60 seconds, as the app
 * does, and the user is away for a minute, so the dialog list is stale.
 */
export const AddRepositoriesRefreshesOnReturn: Story = {
  decorators: [
    (Story) => {
      const [client] = useState(
        () =>
          new QueryClient({
            defaultOptions: { queries: { staleTime: 60_000, retry: false } },
          }),
      )
      return (
        <QueryClientProvider client={client}>
          <Story />
        </QueryClientProvider>
      )
    },
  ],
  beforeEach: () => {
    accessReads.count = 0
    addCalls.length = 0
    return () => {
      Date.now = realDateNow
      focusManager.setFocused(undefined)
    }
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          ...workspaceSourceChangeHandlers(addCalls),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/github/installation/repositories",
              ),
            () => {
              accessReads.count += 1
              const repositories = [
                ...(accessReads.count > 1
                  ? [
                      {
                        name: "billing",
                        clone_url: "https://github.com/acme/billing.git",
                        full_name: "acme/billing",
                        pushed_at: "2026-10-18T00:00:00Z",
                      },
                    ]
                  : []),
                {
                  name: "api",
                  clone_url: "https://github.com/acme/api.git",
                  full_name: "acme/api",
                  pushed_at: "2026-10-01T00:00:00Z",
                },
              ]
              return HttpResponse.json({
                repositories,
                repositorySelection: "selected",
                manageUrl:
                  "https://github.com/organizations/acme/settings/installations/123",
                hasMore: false,
                totalCount: repositories.length,
              })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openAddRepositories(canvasElement)
    await userEvent.click(
      await dialog.findByRole("checkbox", { name: "acme/api" }),
    )
    await expect(accessReads.count).toBe(1)
    // The user is on GitHub for a minute. The tab then gets focus back.
    const start = realDateNow()
    Date.now = () => realDateNow() - start + start + 60_000
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await dialog.findByRole("checkbox", { name: "acme/billing" })
    await expect(accessReads.count).toBe(2)
    // The new repository is first, and the tick stays on acme/api.
    await waitFor(() => {
      expect(dialog.getByRole("checkbox", { name: "acme/api" })).toBeChecked()
      expect(
        dialog.getByRole("checkbox", { name: "acme/billing" }),
      ).not.toBeChecked()
    })
    await expect(dialog.getByText("1 repository selected")).toBeVisible()
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() => expect(addCalls).toHaveLength(1))
    await expect(addCalls[0]).toMatchObject({
      method: "POST",
      body: { source: { scope: { repository: "acme/api" } } },
    })
  },
}

const ownerLine =
  "Only an owner of the GitHub organization can give access. If you are not an owner, ask one to do it."

/**
 * Two GitHub connections: each has its own access link, named after the
 * connection, and a line tells a user who is not an owner what to do.
 */
export const AddRepositoriesHintLinksEachConnection: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          orgConnectionsHandler([
            { id: "con_gh1", type: "github", displayName: "acme-gh" },
            { id: "con_gh2", type: "github", displayName: "acme-labs" },
          ]),
          http.get(/\/github\/installation\/repositories$/, ({ request }) => {
            const second =
              new URL(request.url).searchParams.get("connectionId") ===
              "con_gh2"
            return HttpResponse.json({
              repositories: [
                {
                  name: second ? "tool" : "api",
                  full_name: second ? "labs/tool" : "acme/api",
                  clone_url: `https://github.com/${second ? "labs/tool" : "acme/api"}.git`,
                },
              ],
              repositorySelection: "selected",
              manageUrl: `https://github.com/organizations/${second ? "labs" : "acme"}/settings/installations/${second ? 2 : 1}`,
              hasMore: false,
              totalCount: 1,
            })
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openAddRepositories(canvasElement)
    await dialog.findByRole("checkbox", { name: "labs/tool" })
    await waitFor(() => {
      expect(
        dialog.getByRole("link", { name: "Give ctxpipe access for acme-gh" }),
      ).toHaveAttribute(
        "href",
        "https://github.com/organizations/acme/settings/installations/1",
      )
      expect(
        dialog.getByRole("link", { name: "Give ctxpipe access for acme-labs" }),
      ).toHaveAttribute(
        "href",
        "https://github.com/organizations/labs/settings/installations/2",
      )
      expect(dialog.getByText(ownerLine)).toBeVisible()
    })
  },
}

/**
 * The list does not load: the hint still shows, with a link to the Connectors
 * page, because the access link comes with the list.
 */
export const AddRepositoriesListFailsKeepsHint: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          http.get(/\/github\/installation\/repositories$/, () =>
            HttpResponse.json({ error: "failed" }, { status: 500 }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openAddRepositories(canvasElement)
    await dialog.findByText("Could not load the GitHub repositories.")
    await expect(
      dialog.getByRole("link", {
        name: "Check the GitHub connection on the Connectors page",
      }),
    ).toHaveAttribute("href", "/acme/connectors")
    await waitFor(() => expect(dialog.getByText(ownerLine)).toBeVisible())
  },
}

/** A Workspace below format 2: the dialog says to upgrade first and offers no list. */
export const AddRepositoriesNeedUpgradeFirst: Story = {
  parameters: {
    msw: {
      handlers: {
        upgrades: [
          workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 1 })),
        ],
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openAddRepositories(canvasElement)
    await dialog.findByText(
      "Upgrade this Workspace before you add repositories",
    )
    await dialog.findByRole("button", { name: "Review upgrades" })
    await waitFor(() =>
      expect(
        dialog.queryByRole("button", { name: "Open a pull request" }),
      ).not.toBeInTheDocument(),
    )
  },
}

/** A few repositories: every row shows, with no filter and no "Show all". */
export const GithubThreeRepositories: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                {
                  ...githubSource,
                  scope: { repositories: ["acme/api", "acme/web", "acme/cli"] },
                  scopeSummary: "3 repositories",
                },
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const list = within(
      await canvas.findByRole("list", { name: "GitHub repositories" }),
    )
    await expect(canvas.getByText("3 repositories")).toBeVisible()
    await expect(list.getAllByRole("listitem")).toHaveLength(3)
    await expect(canvas.queryByRole("searchbox")).toBeNull()
    await expect(canvas.queryByRole("button", { name: /Show all/ })).toBeNull()
    await expect(
      canvas.getByRole("button", { name: "Unlink acme/cli" }),
    ).toBeVisible()
  },
}

const manyLinkedRepositories = Array.from({ length: 312 }, (_, index) => {
  const name = `acme/service-${String(index + 1).padStart(3, "0")}`
  const withIssues = (index + 1) % 75 === 0
  return {
    id: `lnk_many_${index + 1}`,
    workspaceId: "ws_story1",
    gitUrl: `https://github.com/${name}`,
    desiredRef: null,
    desiredSha: "abc",
    indexedSha: "abc",
    createdAt: "2026-10-01T10:00:00.000Z",
    ...(withIssues
      ? {
          indexingStatus: "complete_with_issues" as const,
          indexingError: "Code intelligence is incomplete for 1 project",
        }
      : {}),
  }
})

/**
 * Hundreds of repositories: the meta line counts them, the first 5 show
 * (rows that need attention first), "Show all" opens a scroll area, and the
 * filter narrows the list.
 */
export const GithubManyRepositories: Story = {
  args: { linkedRepositories: manyLinkedRepositories },
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                {
                  ...githubSource,
                  scope: {
                    repositories: manyLinkedRepositories.map((repo) =>
                      repo.gitUrl.replace("https://github.com/", ""),
                    ),
                  },
                  scopeSummary: "312 repositories",
                },
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("312 repositories · 4 need attention")
    const listElement = canvas.getByRole("list", {
      name: "GitHub repositories",
    })
    const list = within(listElement)
    await expect(list.getAllByRole("listitem")).toHaveLength(5)
    await expect(list.getAllByText("Indexed with issues")).toHaveLength(4)

    await expect(list.queryByText("Linked by a repositories file")).toBeNull()
    const toggle = canvas.getByRole("button", { name: "Show all 312" })
    await expect(listElement.id).not.toBe("")
    await expect(toggle).toHaveAttribute("aria-controls", listElement.id)
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    toggle.focus()
    await expect(toggle).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"))
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-controls", listElement.id),
    )
    await expect(list.getAllByRole("listitem")).toHaveLength(312)
    await expect(listElement.scrollHeight).toBeGreaterThan(
      listElement.clientHeight,
    )
    await expect(toggle).toHaveAccessibleName("Show fewer")
    await waitFor(() => expect(toggle).toHaveFocus())
    await userEvent.keyboard(" ")
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-expanded", "false"),
    )
    await expect(list.getAllByRole("listitem")).toHaveLength(5)

    const filter = canvas.getByRole("searchbox", {
      name: "Filter linked repositories",
    })
    await userEvent.type(filter, "service-01")
    await waitFor(() => expect(list.getAllByRole("listitem")).toHaveLength(10))
    await expect(canvas.queryByRole("button", { name: /Show all/ })).toBeNull()
    await userEvent.clear(filter)
    await userEvent.type(filter, "no-such-repository")
    await waitFor(() =>
      expect(
        list.getByText("No repositories match that filter."),
      ).toBeVisible(),
    )
  },
}

/** A file in a known provider folder that does not parse: the row shows why. */
export const InvalidFile: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                linearSource,
                workspaceSourceFixture({
                  path: "sources/linear/broken.md",
                  provider: "linear",
                  connectionId: "con_li1",
                  connectionName: "Acme Linear",
                  status: "invalid",
                  statusDetail:
                    "sources/linear/broken.md: teams: Expected an array",
                  scopeSummary: "Linear",
                }),
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("2 sources from 1 connector · 1 needs attention")
    await expect(canvas.getByText("Not valid")).toBeVisible()
    await expect(
      canvas.getByText("sources/linear/broken.md: teams: Expected an array"),
    ).toBeVisible()
    // An invalid file is a real file: the user can still remove it.
    await expect(
      canvas.getByRole("button", { name: "Remove sources/linear/broken.md" }),
    ).toBeVisible()
  },
}

/** An open rename pull request shows on the old path. */
export const PendingRename: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [linearSource],
              pendingChanges: [
                {
                  path: "sources/linear/eng-issues.md",
                  provider: "linear",
                  action: "rename",
                  pullRequestUrl: "https://github.com/acme/docs/pull/8",
                  createdAt: "2026-10-10T10:00:00.000Z",
                },
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("link", { name: /^Rename awaiting merge\./ }),
      ).toHaveAttribute("href", "https://github.com/acme/docs/pull/8"),
    )
    await expect(
      canvas.getByText("1 change awaiting merge", { exact: false }),
    ).toBeVisible()
  },
}

const renameCalls: ChangeCall[] = []

/** The rename dialog sends the new path and keeps the provider folder. */
export const RenameSendsChange: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({ items: [linearSource] }),
          ),
          connected,
          ...workspaceSourceChangeHandlers(renameCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    renameCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Rename sources/linear/eng-issues.md",
      }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    const name = dialog.getByRole("textbox", { name: "File name" })
    await expect(name).toHaveValue("eng-issues")
    // The same name is no change.
    await expect(
      dialog.getByRole("button", { name: "Open a pull request" }),
    ).toBeDisabled()
    await userEvent.clear(name)
    await userEvent.type(name, "platform-issues")
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() => expect(renameCalls).toHaveLength(1))
    await expect(renameCalls[0]).toMatchObject({
      method: "POST",
      path: "/acme/api/v1/workspaces/docs/sources/rename",
      body: {
        path: "sources/linear/eng-issues.md",
        newPath: "sources/linear/platform-issues.md",
      },
    })
  },
}

const describeCalls: ChangeCall[] = []

/** The editor sends the description with the change. */
export const EditDescriptionSendsChange: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({ items: [linearSource] }),
          ),
          connected,
          linearAvailableScopesHandler(),
          ...workspaceSourceChangeHandlers(describeCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    describeCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Edit sources/linear/eng-issues.md",
      }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    const description = await dialog.findByRole("textbox", {
      name: "Description (optional)",
    })
    await expect(description).toHaveValue(
      "Engineering issues. Ingest them for the weekly review.",
    )
    await userEvent.clear(description)
    await userEvent.type(description, "Issues of the platform team.")
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() => expect(describeCalls).toHaveLength(1))
    await expect(describeCalls[0]).toMatchObject({
      method: "PUT",
      body: {
        path: "sources/linear/eng-issues.md",
        source: { description: "Issues of the platform team." },
      },
    })
  },
}

const nameCalls: ChangeCall[] = []

/** An add can name the file; the server names it otherwise. */
export const AddWithFileName: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          linearAvailableScopesHandler(),
          ...workspaceSourceChangeHandlers(nameCalls),
        ],
      },
    },
  },
  beforeEach: () => {
    nameCalls.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add Linear source" }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await userEvent.click(
      await dialog.findByRole("checkbox", { name: /Engineering/ }),
    )
    await userEvent.type(
      dialog.getByRole("textbox", { name: "File name (optional)" }),
      "eng-issues",
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() => expect(nameCalls).toHaveLength(1))
    await expect(nameCalls[0]).toMatchObject({
      method: "POST",
      body: { path: "sources/linear/eng-issues.md" },
    })
  },
}

const linkedRepository = (
  name: string,
  sha: { desired: string | null; indexed: string | null },
) => ({
  id: `lnk_${name}`,
  workspaceId: "ws_story1",
  gitUrl: `https://github.com/acme/${name}.git`,
  desiredRef: null,
  desiredSha: sha.desired,
  indexedSha: sha.indexed,
  createdAt: "2026-10-01T10:00:00.000Z",
})

/** Each repository status explains itself on hover and on keyboard focus. */
export const StatusExplainsItself: Story = {
  args: {
    linkedRepositories: [
      linkedRepository("api", { desired: null, indexed: null }),
      linkedRepository("web", { desired: "def", indexed: "abc" }),
      linkedRepository("cli", { desired: "abc", indexed: "abc" }),
    ],
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                {
                  ...githubSource,
                  scope: { repositories: ["acme/api", "acme/web", "acme/cli"] },
                  scopeSummary: "3 repositories",
                },
              ],
            }),
          ),
          connected,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const list = within(
      await canvas.findByRole("list", { name: "GitHub repositories" }),
    )
    // The tip renders in a portal. It is the only tip open at one time.
    const tip = () =>
      document.body.querySelector<HTMLElement>('[data-slot="tooltip-content"]')
    // A pointer user sees the tip on hover.
    await userEvent.hover(list.getByText("Indexing"))
    await waitFor(() => {
      expect(tip()).toBeVisible()
      expect(tip()).toHaveTextContent(
        "ctx| knows the latest commit of this repository. It has not indexed that commit yet.",
      )
    })
    await userEvent.unhover(list.getByText("Indexing"))
    await waitFor(() => expect(tip()).toBeNull())
    // A keyboard user reaches the status with Tab, and focus shows the tip.
    for (
      let step = 0;
      step < 20 && document.activeElement !== list.getByText("Pending");
      step++
    )
      await userEvent.tab()
    await waitFor(() => {
      expect(list.getByText("Pending")).toHaveFocus()
      expect(tip()).toHaveTextContent(
        /^ctx\| has not read this repository yet\.$/,
      )
    })
    // A screen reader gets the same text with the status.
    await expect(
      list.getByRole("button", {
        name: "Pending ctx| has not read this repository yet.",
      }),
    ).toBeVisible()
  },
}

/** The list requests of the picker that a member must not send. */
const memberPickerReads: string[] = []
const recordPickerRead = http.get(
  ({ request }) =>
    /\/api\/v1\/(connectors\/linear\/available-scopes|github\/installation\/repositories)$/.test(
      new URL(request.url).pathname,
    ),
  ({ request }) => {
    memberPickerReads.push(new URL(request.url).pathname)
    return HttpResponse.json({ error: "Forbidden" }, { status: 403 })
  },
)

/**
 * A member can edit a source, but only an owner or admin can list the
 * Linear teams and projects. The dialog asks for an admin and sends no list
 * request.
 */
export const MemberEditAsksAnAdmin: Story = {
  parameters: {
    msw: {
      handlers: {
        role: [activeMemberRoleHandler("member")],
        page: [
          workspaceSourcesHandler(
            workspaceSourceList({ items: [linearSource] }),
          ),
          connected,
          recordPickerRead,
        ],
      },
    },
  },
  beforeEach: () => {
    memberPickerReads.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Edit sources/linear/eng-issues.md",
      }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await dialog.findByRole("heading", { name: "Edit Linear source" })
    await dialog.findByText(/Ask an admin to choose what this source syncs/)
    await waitFor(() =>
      expect(
        dialog.queryByRole("checkbox", { name: /Engineering/ }),
      ).not.toBeInTheDocument(),
    )
    expect(memberPickerReads).toEqual([])
  },
}

/** A member opens Add repositories: a note asks for an admin, and no list request goes out. */
export const MemberAddRepositoriesAsksAnAdmin: Story = {
  parameters: {
    msw: {
      handlers: {
        role: [activeMemberRoleHandler("member")],
        page: [
          workspaceSourcesHandler(workspaceSourceList()),
          connected,
          recordPickerRead,
        ],
      },
    },
  },
  beforeEach: () => {
    memberPickerReads.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add repositories" }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await dialog.findByText(/Ask an admin to add repositories/)
    await waitFor(() =>
      expect(
        dialog.queryByRole("searchbox", { name: "Search GitHub repositories" }),
      ).not.toBeInTheDocument(),
    )
    expect(memberPickerReads).toEqual([])
  },
}
