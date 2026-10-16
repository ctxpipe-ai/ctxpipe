import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { linearAvailableScopesHandler } from "@/mocks/linear-handlers"
import { githubInstallationReposHandler } from "@/mocks/workspace-handlers"
import {
  orgConnectionsHandler,
  workspaceSourceChangeHandlers,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
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
    await expect(
      group.getByRole("link", { name: "Awaiting merge" }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/5")
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
    const links = await canvas.findAllByRole("link", { name: "Awaiting merge" })
    await expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/acme/docs/pull/3",
      "https://github.com/acme/docs/pull/5",
    ])
    await expect(
      canvas.getByRole("link", { name: "Removal awaiting merge" }),
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

/** The GitHub group with no repositories yet. */
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
    await canvas.findByText("No GitHub repositories in this Workspace.")
    const section = canvasElement.querySelector<HTMLElement>("#source-github")
    if (!section) throw new Error("Missing GitHub group")
    const group = within(section)
    await expect(group.getByText("No GitHub sources yet")).toBeVisible()
    await expect(group.queryByRole("searchbox")).toBeNull()
    await expect(
      group.getByRole("button", { name: "Add repositories" }),
    ).toBeVisible()
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
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Show all 312" }),
      ).toHaveAttribute("aria-expanded", "true"),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Show all 312" }),
      ).toHaveAttribute("aria-controls", listElement.id),
    )
    await expect(list.getAllByRole("listitem")).toHaveLength(312)
    await expect(listElement.scrollHeight).toBeGreaterThan(
      listElement.clientHeight,
    )
    await expect(toggle).toHaveAccessibleName("Show fewer")
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Show all 312" }),
      ).toHaveFocus(),
    )
    await userEvent.keyboard(" ")
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Show all 312" }),
      ).toHaveAttribute("aria-expanded", "false"),
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
        canvas.getByRole("link", { name: "Rename awaiting merge" }),
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
