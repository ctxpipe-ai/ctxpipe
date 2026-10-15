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
  sourceKey: "product-repos",
  provider: "github",
  connectionId: "con_gh1",
  connectionName: "acme-gh",
  scope: { repositories: ["acme/api", "acme/web"] },
  scopeSummary: "2 repositories",
})
const confluenceSource = workspaceSourceFixture({
  sourceKey: "eng-docs",
  provider: "confluence",
  connectionId: "con_cf1",
  connectionName: "acme.atlassian.net",
  scopeSummary: "3 spaces",
})
const linearSource = workspaceSourceFixture({
  sourceKey: "eng-issues",
  provider: "linear",
  connectionId: "con_li1",
  connectionName: "Acme Linear",
  scope: { teams: ["ENG"] },
  scopeSummary: "1 team",
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
    await expect(canvas.queryByText(".ctxpipe/sources.yaml")).toBeNull()
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
              items: [githubSource, confluenceSource, linearSource],
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
    await expect(canvas.getByText("3 sources from 3 connectors")).toBeVisible()
    await expect(canvas.getByText(".ctxpipe/sources.yaml")).toBeVisible()
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
                  sourceKey: "ops-issues",
                  scopeSummary: "2 teams",
                },
                {
                  ...linearSource,
                  sourceKey: "labs-issues",
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
      group.getByRole("button", { name: "Edit labs-issues" }),
    ).toBeVisible()
    await expect(canvas.getAllByRole("heading", { level: 3 })).toHaveLength(1)
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
                  sourceKey: "old-issues",
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
                  sourceKey: "eng-docs",
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
                  sourceKey: "bad-shape",
                  provider: "linear",
                  status: "invalid",
                  statusDetail: "teams: Expected an array",
                  scopeSummary: "Linear",
                }),
                workspaceSourceFixture({
                  sourceKey: "old-linear",
                  provider: "linear",
                  connectionId: "con_gone",
                  connectionName: null,
                  status: "connection_missing",
                  statusDetail: "The connection con_gone does not exist",
                  scopeSummary: "1 team",
                }),
                workspaceSourceFixture({
                  sourceKey: "eng-channels",
                  provider: "slack",
                  status: "ok",
                  statusDetail: "Channel #old is archived",
                  scopeSummary: "2 Slack channels",
                }),
                workspaceSourceFixture({
                  sourceKey: "secret-space",
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
                  sourceKey: "product-repos",
                  provider: "github",
                  action: "edit",
                  pullRequestUrl: "https://github.com/acme/docs/pull/3",
                  createdAt: "2026-10-10T10:00:00.000Z",
                },
                {
                  sourceKey: "eng-issues",
                  provider: "linear",
                  action: "remove",
                  pullRequestUrl: "https://github.com/acme/docs/pull/4",
                  createdAt: "2026-10-10T10:00:00.000Z",
                },
                {
                  sourceKey: "eng-docs",
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
                { ...githubSource, sourceKey: "more-repos" },
                { ...githubSource, sourceKey: "even-more-repos" },
                confluenceSource,
                { ...confluenceSource, sourceKey: "more-docs" },
                linearSource,
                { ...linearSource, sourceKey: "more-issues" },
                { ...linearSource, sourceKey: "even-more-issues" },
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
      await canvas.findByRole("button", { name: "Edit eng-issues" }),
    )
    const dialog = within(await within(document.body).findByRole("dialog"))
    await dialog.findByRole("heading", { name: "Edit Linear source" })
    await expect(
      await dialog.findByRole("checkbox", { name: /Engineering/ }),
    ).toBeChecked()
    await userEvent.click(dialog.getByRole("checkbox", { name: /Operations/ }))
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() => expect(editCalls).toHaveLength(1))
    await expect(editCalls[0]).toEqual({
      method: "PUT",
      path: "/acme/api/v1/workspaces/docs/sources/eng-issues",
      body: {
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
    await expect(editCalls[0]).toEqual({
      method: "PUT",
      path: "/acme/api/v1/workspaces/docs/sources/product-repos",
      body: {
        source: {
          provider: "github",
          connectionId: "con_gh1",
          scope: { repositories: ["acme/web"] },
        },
      },
    })
    await within(document.body).findByText(/Pull request opened/)
  },
}

const unlinkCalls: ChangeCall[] = []

/**
 * The last repository of a GitHub source goes: the source goes, and a
 * repositories file that links the same repository goes too.
 */
export const UnlinkLastRepositoryRemovesEveryLink: Story = {
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
                  scope: { repositories: ["acme/api"] },
                  scopeSummary: "1 linked repository",
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
              return HttpResponse.json(
                {
                  queued: true,
                  action: "unlink",
                  gitUrl: "https://github.com/acme/api",
                },
                { status: 202 },
              )
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
    await waitFor(() => expect(unlinkCalls).toHaveLength(2))
    await expect(unlinkCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "DELETE",
          path: "/acme/api/v1/workspaces/docs/linked-repositories/lnk_api",
        }),
        expect.objectContaining({
          method: "DELETE",
          path: "/acme/api/v1/workspaces/docs/sources/product-repos",
        }),
      ]),
    )
  },
}

export const LegacyLinkedRepositoryShows: Story = {
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
    await expect(list.getAllByRole("listitem")).toHaveLength(3)
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
          scope: { repositories: ["acme/api"] },
        },
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
      await canvas.findByRole("button", { name: "Remove eng-docs" }),
    )
    const dialog = within(await within(document.body).findByRole("alertdialog"))
    await userEvent.click(
      dialog.getByRole("button", { name: "Open a pull request" }),
    )
    await waitFor(() => expect(removeCalls).toHaveLength(1))
    await expect(removeCalls[0]).toMatchObject({
      method: "DELETE",
      path: "/acme/api/v1/workspaces/docs/sources/eng-docs",
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
    await canvas.findByText("The sources file is not valid")
    await expect(canvas.getByText("version: Expected 1")).toBeVisible()
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
      canvas.queryByRole("button", { name: "Remove eng-issues" }),
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
    await waitFor(() => expect(pickerCalls).toHaveLength(2))
    await expect(
      pickerCalls.map((call) => (call.body as { source: unknown }).source),
    ).toEqual(
      expect.arrayContaining([
        {
          provider: "github",
          connectionId: "con_gh1",
          scope: { repositories: ["acme/api"] },
        },
        {
          provider: "github",
          connectionId: "con_gh2",
          scope: { repositories: ["labs/tool"] },
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
        page: [workspaceSourcesHandler(workspaceSourceList()), connected],
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

    await userEvent.click(canvas.getByRole("button", { name: "Show all 312" }))
    await expect(list.getAllByRole("listitem")).toHaveLength(312)
    await expect(listElement.scrollHeight).toBeGreaterThan(
      listElement.clientHeight,
    )
    await userEvent.click(canvas.getByRole("button", { name: "Show fewer" }))
    await expect(list.getAllByRole("listitem")).toHaveLength(5)

    const filter = canvas.getByRole("searchbox", {
      name: "Filter linked repositories",
    })
    await userEvent.type(filter, "service-01")
    await waitFor(() => expect(list.getAllByRole("listitem")).toHaveLength(10))
    await expect(canvas.queryByRole("button", { name: /Show all/ })).toBeNull()
    await userEvent.clear(filter)
    await userEvent.type(filter, "no-such-repository")
    await expect(
      await list.findByText("No repositories match that filter."),
    ).toBeVisible()
  },
}
