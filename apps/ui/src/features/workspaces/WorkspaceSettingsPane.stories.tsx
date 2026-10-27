import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import {
  githubInstallationReposHandler,
  workspaceActivityHandler,
  workspaceDetailHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import {
  ingestionItemFixture,
  workspaceIngestionHandlers,
} from "@/mocks/workspace-ingestion-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"
import { OrgHomePageContent } from "@/routes/$orgSlug.index"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  docsWorkspace,
  docsWorkspaceDetail,
  emptyLinkedWorkspaceDetail,
  failedHydrateWorkspaceDetail,
  hydratingWorkspaceDetail,
  projectionLagWorkspaceDetail,
  readOnlyWorkspaceDetail,
  rootFolderWorkspaceDetail,
  skippedFilesWorkspaceDetail,
} from "./workspace-fixtures"
import { WorkspaceSettingsPane } from "./WorkspaceSettingsPane"

const meta = {
  title: "Components/Workspaces/SettingsPane",
  component: WorkspaceSettingsPane,
  decorators: [
    (Story) => (
      <div className="h-[40rem] overflow-auto bg-zinc-950">
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
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler(),
        ],
        sources: [
          workspaceSourcesHandler(workspaceSourceList()),
          orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
        ],
        upgrades: [
          workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
        ],
      },
    },
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspaceDetail,
    onOpenFile: fn(),
  },
} satisfies Meta<typeof WorkspaceSettingsPane>

export default meta

type Story = StoryObj<typeof meta>

export const Settings: Story = {}

/**
 * One card for each part, in this order: Upgrades, Sources, Knowledge graph,
 * Repository, Workspace, and Danger zone. Each card states its state in its
 * body. The Sources card shows three providers.
 */
export const Populated: Story = {
  parameters: {
    msw: {
      handlers: {
        sources: [
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                workspaceSourceFixture({
                  path: "product-repos",
                  provider: "github",
                  connectionId: "con_gh1",
                  connectionName: "acme-gh",
                  scope: { repositories: ["acme/api", "acme/web"] },
                  scopeSummary: "2 repositories",
                }),
                workspaceSourceFixture({
                  path: "eng-docs",
                  provider: "confluence",
                  connectionId: "con_cf1",
                  connectionName: "acme.atlassian.net",
                  scopeSummary: "3 spaces",
                }),
                workspaceSourceFixture({
                  path: "eng-issues",
                  provider: "linear",
                  connectionId: "con_li1",
                  connectionName: "Acme Linear",
                  scope: { teams: ["ENG"] },
                  scopeSummary: "1 team",
                }),
              ],
            }),
          ),
          orgConnectionsHandler([
            { id: "con_gh1", type: "github", displayName: "acme-gh" },
            { id: "con_cf1", type: "forge" },
            { id: "con_li1", type: "linear" },
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("acme/api")
    const cards = canvas
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent)
    await expect(cards).toEqual([
      "Upgrades",
      "Sources",
      "Knowledge graph",
      "Repository",
      "Workspace",
      "Danger zone",
    ])
    await expect(
      canvas.getByText("ctxpipe can push to this repository."),
    ).toBeVisible()
    await expect(
      canvas.getByText("The knowledge graph is loaded."),
    ).toBeVisible()
    await expect(canvas.getByText("Everything is up to date.")).toBeVisible()
    await expect(canvas.getByRole("textbox", { name: "Name" })).toHaveValue(
      docsWorkspaceDetail.displayName,
    )
    await expect(
      canvas.getByText("Shown in the sidebar and to your team."),
    ).toBeVisible()
    await expect(canvas.getByRole("textbox", { name: "URL name" })).toHaveValue(
      docsWorkspaceDetail.slug,
    )
    await expect(
      canvas.getByRole("region", { name: "Repository" }),
    ).toBeVisible()
    await expect(
      canvas.getByRole("region", { name: "Sources" }),
    ).toBeInTheDocument()
    await expect(
      canvas.getByRole("link", { name: "Add connection" }),
    ).toHaveAttribute("href", "/acme/connectors")
    await expect(
      canvas.getByRole("heading", { level: 3, name: "Delete this Workspace" }),
    ).toBeVisible()
  },
}

/**
 * The Knowledge graph card lists every file that hydrate skipped, and marks
 * the card and the summary. A file that is only a legacy overlay
 * (knowledge from before Workspaces, built from the database) shows its
 * cause and no fix button, because no edit of the Workspace repository
 * changes it.
 */
export const SkippedFiles: Story = {
  args: {
    workspace: skippedFilesWorkspaceDetail,
    onFixWithAgent: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("ctxpipe skipped 3 files")
    // The summary names the card that needs the user.
    await waitFor(() =>
      expect(
        canvas.getByRole("link", { name: "Knowledge graph" }),
      ).toBeVisible(),
    )
    await canvas.findByText("Front matter is not valid")
    await canvas.findByText(
      "Repeats a linked repository or the Workspace's own repository",
    )
    expect(
      canvas.getByRole("link", { name: "knowledge/billing/tax.md" }),
    ).toBeVisible()
    // A legacy overlay file is not in Git: the row names the cause and has no fix.
    await canvas.findByText(
      "Knowledge from before Workspaces. ctxpipe shows it from its database, so it cannot be fixed here.",
    )
    // Its path is not in Git, so it is plain text: the Files pane would show "File not found".
    expect(canvas.getByText("knowledge/apis/imported.md")).toBeVisible()
    expect(
      canvas.queryByRole("link", { name: "knowledge/apis/imported.md" }),
    ).toBeNull()
    expect(
      canvas.queryByRole("button", {
        name: "Fix knowledge/apis/imported.md using agent",
      }),
    ).toBeNull()
    // Only the front matter file of Git offers the agent.
    expect(
      canvas.queryByRole("button", {
        name: "Fix repositories/app-copy.md using agent",
      }),
    ).toBeNull()
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Fix knowledge/billing/tax.md using agent",
      }),
    )
    await expect(args.onFixWithAgent).toHaveBeenCalledWith(
      "Hydrate skipped knowledge/billing/tax.md: Front matter is not valid. Fix the front matter of this file so that it is valid, then open the change.",
    )
  },
}

/** A link with the upgrades hash lands on the Upgrades card: it gets the focus. */
export const LandsOnUpgrades: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
      search: "#upgrades",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        within(canvasElement).getByRole("region", { name: "Upgrades" }),
      ).toHaveFocus(),
    )
  },
}

export const ReadOnly: Story = {
  args: {
    workspace: readOnlyWorkspaceDetail,
  },
}

/** A protected default branch: a neutral note, no warning and no "fix it". */
export const ProtectedDefaultBranch: Story = {
  args: {
    workspace: {
      ...readOnlyWorkspaceDetail,
      conversationWritable: true,
      readOnlyReason:
        "The default branch is protected. Jobs cannot push it; conversation chat can still push a session branch and open a pull request.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Changes by pull request")
    await canvas.findByText(
      "The default branch is protected. A conversation pushes its own branch and opens a pull request.",
    )
    await waitFor(() => expect(canvas.queryByRole("alert")).toBeNull())
    await waitFor(() => expect(canvas.queryByText(/fix it/)).toBeNull())
    await waitFor(() => expect(canvas.queryByText("Read-only")).toBeNull())
  },
}

/**
 * A Paste Workspace that no GitHub connection reads. "Select the repository
 * again" opens the context repository dialog, where Select GitHub binds it.
 */
export const ReadOnlyWithoutConnection: Story = {
  args: {
    workspace: {
      ...readOnlyWorkspaceDetail,
      githubConnectionId: null,
      readOnlyReason:
        "GitHub is not connected for this organization. An owner or admin must install the GitHub App and add this repository to the installation.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Select the repository again",
      }),
    )
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole("dialog")
    await waitFor(() =>
      expect(
        within(dialog).getByRole("heading", { name: "Context repository" }),
      ).toBeVisible(),
    )
  },
}

export const ProjectionLag: Story = {
  args: {
    workspace: projectionLagWorkspaceDetail,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/Answers still come from/)
    await expect(
      canvas.getByText(/until the new repository finishes loading/),
    ).toBeVisible()
  },
}

export const EmptyLinkedRepos: Story = {
  args: {
    workspace: emptyLinkedWorkspaceDetail,
  },
}

export const LinkedRepositoryWithIssues: Story = {
  args: {
    workspace: {
      ...docsWorkspaceDetail,
      linkedRepositories: docsWorkspaceDetail.linkedRepositories.map(
        (repository, index) =>
          index === 0
            ? {
                ...repository,
                indexedSha: repository.desiredSha ?? repository.indexedSha,
                indexingStatus: "complete_with_issues",
                indexingError:
                  "TypeScript code intelligence is incomplete: 1 of 6 projects could not be indexed (packages/broken)",
              }
            : repository,
      ),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Indexed with issues")
    await canvas.findByText(/1 of 6 projects could not be indexed/)
  },
}

/**
 * The context repository picker and "Add repositories" share one cached
 * repository query. Opening one, then the other, lists the repositories.
 */
export const AddRepositories: Story = {
  args: {
    workspace: emptyLinkedWorkspaceDetail,
  },
  parameters: {
    // Only an owner or admin sees the repository pickers. The Add
    // repositories dialog reads the Workspace and its format (2 or higher).
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Change the context repository",
      }),
    )
    const picker = await body.findByRole("dialog")
    await within(picker).findByText("acme/handbook")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(body.queryByRole("dialog")).toBeNull())

    await userEvent.click(
      await canvas.findByRole("button", { name: /add repositories/i }),
    )
    const dialog = await body.findByRole("dialog", {
      name: /add repositories/i,
    })
    await expect(
      await within(dialog).findByText("acme/handbook"),
    ).toBeInTheDocument()
  },
}

export const Hydrating: Story = {
  args: {
    workspace: hydratingWorkspaceDetail,
  },
}

/** A hydrate that failed: the Knowledge graph card says it, with the reason. */
export const HydrateFailed: Story = {
  args: {
    workspace: failedHydrateWorkspaceDetail,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("The knowledge graph did not load")
    // The summary names the card that needs the user.
    await waitFor(() =>
      expect(
        canvas.getByRole("link", { name: "Knowledge graph" }),
      ).toBeVisible(),
    )
  },
}

/** A GitHub source of acme/app and a Linear source. */
const appAndLinearSources = (linearStatus: "ok" | "out_of_access") =>
  workspaceSourceList({
    items: [
      workspaceSourceFixture({
        path: "sources/github/acme/app.md",
        provider: "github",
        connectionId: "con_gh",
        connectionName: "acme",
        scope: { repository: "acme/app" },
        scopeSummary: "acme/app",
      }),
      workspaceSourceFixture({
        path: "sources/linear/eng.md",
        provider: "linear",
        connectionId: "con_li",
        connectionName: "Acme Linear",
        scope: { teams: ["ENG"] },
        scopeSummary: "1 team",
        ...(linearStatus === "out_of_access"
          ? {
              status: "out_of_access" as const,
              statusDetail:
                "The Linear connection cannot read the team ENG. Give it access in Linear, or remove the team.",
            }
          : {}),
      }),
    ],
    ...(linearStatus === "out_of_access"
      ? {
          pendingChanges: [
            {
              path: "sources/linear/support.md",
              provider: "linear" as const,
              action: "add" as const,
              pullRequestUrl: "https://github.com/acme/docs/pull/31",
              createdAt: "2026-10-27T09:10:00.000Z",
            },
          ],
        }
      : {}),
  })

/** Three runs of acme/app (one for each push), a Linear sync, and a hydrate. */
const busyIngestion = workspaceIngestionHandlers({
  docs: [
    ingestionItemFixture({
      id: "run_publish",
      name: "acme/app",
      stage: "publishing",
      progress: null,
      minutesAgo: 80,
    }),
    ingestionItemFixture({ id: "run_read", name: "acme/app", minutesAgo: 30 }),
    ingestionItemFixture({
      id: "run_wait",
      name: "acme/app",
      stage: "waiting",
      progress: null,
      minutesAgo: 5,
    }),
    ingestionItemFixture({
      id: "run_linear",
      kind: "source_sync",
      name: "Linear",
      stage: null,
      progress: null,
      minutesAgo: 20,
    }),
    ingestionItemFixture({
      id: "run_hydrate",
      kind: "hydrate",
      name: null,
      stage: null,
      progress: null,
      minutesAgo: 3,
    }),
  ],
})

/**
 * Each source shows its live work in its own row: the word of the run that
 * is the furthest, and its time. "3 runs" opens each run with its stage, its
 * count, and why it waits. The Knowledge graph card shows the hydrate. The
 * summary names the parts at work and moves to a card.
 */
export const LiveWorkInSources: Story = {
  parameters: {
    msw: {
      handlers: {
        sources: [
          workspaceSourcesHandler(appAndLinearSources("ok")),
          orgConnectionsHandler([
            { id: "con_gh", type: "github", displayName: "acme" },
            { id: "con_li", type: "linear", displayName: "Acme Linear" },
          ]),
        ],
        ingestion: busyIngestion,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const sources = within(
      await canvas.findByRole("region", { name: "Sources" }),
    )
    await sources.findByText("Publishing")
    await sources.findByText("Syncing")
    await userEvent.click(
      sources.getByRole("button", { name: "Show the 3 runs of acme/app" }),
    )
    await expect(sources.getByText("3 of 8 parts done")).toBeVisible()
    await expect(
      sources.getByText(
        "Two runs of one repository do not publish at the same time. This run starts when the earlier run ends.",
      ),
    ).toBeVisible()
    await expect(
      sources.getByText("You can leave this page. The work continues."),
    ).toBeVisible()
    await expect(canvas.getByText("Indexing the newest commit…")).toBeVisible()
    await expect(canvas.getByText(/Nothing needs you\. Running:/)).toBeVisible()
    await userEvent.click(canvas.getByRole("link", { name: "Knowledge graph" }))
    await expect(
      canvas.getByRole("region", { name: "Knowledge graph" }),
    ).toHaveFocus()
  },
}

/**
 * A source with a problem shows the problem, also while its sync runs. The
 * summary counts the sources: the problem and the source that waits for its
 * merge.
 */
export const SourceProblemsNeedYou: Story = {
  parameters: {
    msw: {
      handlers: {
        sources: [
          workspaceSourcesHandler(appAndLinearSources("out_of_access")),
          orgConnectionsHandler([
            { id: "con_gh", type: "github", displayName: "acme" },
            { id: "con_li", type: "linear", displayName: "Acme Linear" },
          ]),
        ],
        ingestion: busyIngestion,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const sources = within(
      await canvas.findByRole("region", { name: "Sources" }),
    )
    await sources.findByText("Out of access")
    // The live work loads after the org read: it shows under the problem.
    await waitFor(() => expect(sources.getByText("Syncing now")).toBeVisible())
    await expect(sources.queryByText("Syncing")).toBeNull()
    await expect(sources.getByText("Awaiting merge")).toBeVisible()
    await expect(
      sources.getByRole("link", {
        name: "Open the pull request. It opens on GitHub in a new tab.",
      }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/31")
    await waitFor(() =>
      expect(canvas.getByText(/1 part needs you:/)).toBeVisible(),
    )
    await expect(canvas.getByRole("link", { name: "Sources" })).toBeVisible()
  },
}

/** Twelve applied upgrades, one each 3 days back from Oct 21. */
const longHistory = Array.from({ length: 12 }, (_, index) =>
  upgradeItemFixture({
    key: `reingest-${index}`,
    kind: "reingest",
    title: `Re-ingestion ${12 - index}`,
    status: "completed",
    fromFormat: 3,
    targetFormat: 3,
    steps: [],
    updatedAt: new Date(
      Date.UTC(2026, 9, 21, 6) - index * 3 * 86_400_000,
    ).toISOString(),
  }),
)

/**
 * A long history keeps the card short: five rows show, "Show all" shows the
 * rest. A row opens to what it showed when the upgrade ran.
 */
export const LongUpgradeHistory: Story = {
  parameters: {
    msw: {
      handlers: {
        upgrades: [
          workspaceUpgradesHandler(
            upgradesFixture(longHistory, { formatVersion: 3 }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "History · 12 applied, last on Oct 21",
      }),
    )
    const applied = canvas.getByRole("list", { name: "Applied upgrades" })
    await waitFor(() =>
      expect(within(applied).getAllByRole("listitem")).toHaveLength(5),
    )
    await userEvent.click(canvas.getByRole("button", { name: "Show all 12" }))
    await waitFor(() =>
      expect(within(applied).getAllByRole("listitem")).toHaveLength(12),
    )
    const newest = within(
      within(applied).getByRole("listitem", { name: "Re-ingestion 12" }),
    )
    // A closed row keeps its detail hidden.
    await expect(newest.getByText(/This uses model calls/)).not.toBeVisible()
    await userEvent.click(newest.getByRole("button"))
    await waitFor(() =>
      expect(newest.getByText(/This uses model calls/)).toBeVisible(),
    )
  },
}

const rootFolderPatches: unknown[] = []

/**
 * The Workspace lives in docs/context of a larger repository. The root folder
 * field explains the setting, refuses a path that leaves the repository, and
 * saves a new folder on its own.
 */
export const RootFolder: Story = {
  args: {
    workspace: rootFolderWorkspaceDetail,
  },
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
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler(),
          http.patch(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            async ({ request }) => {
              const body = (await request.json()) as { rootPath?: string }
              rootFolderPatches.push(body)
              return HttpResponse.json({
                ...rootFolderWorkspaceDetail,
                rootPath: body.rootPath ?? rootFolderWorkspaceDetail.rootPath,
              })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    rootFolderPatches.length = 0
    const canvas = within(canvasElement)
    const field = await canvas.findByRole("textbox", { name: /root folder/i })
    await expect(field).toHaveValue("docs/context")
    await expect(
      canvas.getByText(/reads and changes files only in this folder/i),
    ).toBeVisible()
    const save = canvas.getByRole("button", { name: /save root folder/i })
    await expect(save).toBeDisabled()

    await userEvent.clear(field)
    await userEvent.type(field, "../secrets")
    await waitFor(() =>
      expect(canvas.getByText(/use a relative folder path/i)).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: /save root folder/i }),
      ).toBeDisabled(),
    )

    await userEvent.clear(field)
    await userEvent.type(field, "handbook/context/")
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: /save root folder/i }),
      ).toBeEnabled(),
    )
    await userEvent.click(save)
    await waitFor(() =>
      expect(rootFolderPatches).toEqual([{ rootPath: "handbook/context" }]),
    )
  },
}

export const RelinkError: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler(),
          http.patch(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json(
                { error: "That git URL is already used by another Workspace." },
                { status: 409 },
              ),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Change the context repository",
      }),
    )
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole("dialog")
    const scoped = within(dialog)
    await userEvent.click(scoped.getByRole("tab", { name: /paste url/i }))
    await userEvent.type(
      scoped.getByLabelText(/git url/i),
      "https://github.com/acme/taken.git",
    )
    await userEvent.click(scoped.getByRole("button", { name: /^save$/i }))
    await waitFor(() => scoped.getByText(/could not save/i))
  },
}

/**
 * The server refuses a rename it cannot write to AGENTS.md (WS-5). The pane
 * shows the reason and stays on the current slug.
 */
export const RenameRefused: Story = {
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
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler(),
          http.patch(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json(
                {
                  error:
                    "The display name is stored in the Workspace repository, and the rename could not be scheduled there. Connect the repository through GitHub, then try again.",
                },
                { status: 409 },
              ),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const name = canvas.getByRole("textbox", { name: /^name$/i })
    await userEvent.clear(name)
    await userEvent.type(name, "Renamed Workspace")
    await userEvent.click(canvas.getByRole("button", { name: /^save$/i }))
    const body = within(canvasElement.ownerDocument.body)
    await body.findByText(/rename could not be scheduled/i)
    await expect(
      canvas.getByRole("textbox", { name: /^url name$/i }),
    ).toHaveValue(docsWorkspaceDetail.slug)
  },
}

export const DeleteConfirmOpen: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler(),
          http.delete(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            () => new HttpResponse(null, { status: 204 }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Delete Workspace" }),
    )
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole("alertdialog")
    const scoped = within(dialog)
    expect(scoped.getByPlaceholderText("Docs")).toBeInTheDocument()
    await userEvent.type(scoped.getByLabelText("Workspace name"), "Wrong")
    await waitFor(() =>
      expect(
        scoped.getByRole("button", { name: "Delete Workspace" }),
      ).toBeDisabled(),
    )
    await userEvent.clear(scoped.getByLabelText("Workspace name"))
    await userEvent.type(scoped.getByLabelText("Workspace name"), "Docs")
    await waitFor(() =>
      expect(
        scoped.getByRole("button", { name: "Delete Workspace" }),
      ).toBeEnabled(),
    )
    await userEvent.keyboard("{Enter}")
    await waitFor(() => {
      expect(body.queryByRole("alertdialog")).not.toBeInTheDocument()
    })
  },
}

export const DeleteConfirmPending: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler(),
          http.delete(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            async () => {
              await delay("infinite")
              return new HttpResponse(null, { status: 204 })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Delete Workspace" }),
    )
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole("alertdialog")
    const scoped = within(dialog)
    await userEvent.type(scoped.getByLabelText("Workspace name"), "Docs")
    await userEvent.keyboard("{Enter}")
    await waitFor(() => {
      const pending = scoped.getByRole("button", { name: "Delete Workspace" })
      expect(
        pending.querySelector("svg[role='presentation']"),
      ).toBeInTheDocument()
    })
  },
}

/**
 * Delete the only Workspace while Home reads the same list cache. Home must
 * show zero Workspaces at once, also when the list request does not complete.
 */
export const DeleteLastWorkspaceEmptiesHome: Story = {
  render: (args) => (
    <>
      <WorkspaceSettingsPane {...args} />
      <OrgHomePageContent orgSlug="acme" />
    </>
  ),
  parameters: {
    msw: {
      handlers: {
        page: (() => {
          let deleted = false
          return [
            http.get(
              ({ request }) =>
                /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
              async () => {
                if (deleted) await delay("infinite")
                return HttpResponse.json({
                  items: [docsWorkspace],
                  lastUsedWorkspaceId: docsWorkspace.id,
                })
              },
            ),
            workspaceActivityHandler(),
            githubInstallationReposHandler(),
            http.delete(
              ({ request }) =>
                /\/api\/v1\/workspaces\/[^/]+$/.test(
                  new URL(request.url).pathname,
                ),
              () => {
                deleted = true
                return new HttpResponse(null, { status: 204 })
              },
            ),
          ]
        })(),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Query again on each try: Home swaps the disabled composer for a new one when the list loads.
    await waitFor(() =>
      expect(
        canvas.getByPlaceholderText(
          "What should ctxpipe do in this Workspace?",
        ),
      ).toBeEnabled(),
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Delete Workspace" }),
    )
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole("alertdialog")
    await userEvent.type(
      within(dialog).getByLabelText("Workspace name"),
      "Docs",
    )
    await userEvent.keyboard("{Enter}")
    await waitFor(() => {
      expect(body.queryByRole("alertdialog")).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(
        canvas.getByPlaceholderText(
          "What should ctxpipe do in this Workspace?",
        ),
      ).toBeDisabled()
    })
    expect(
      canvas.getByRole("button", { name: "Create Workspace" }),
    ).toBeVisible()
  },
}
