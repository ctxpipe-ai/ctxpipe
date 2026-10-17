import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import {
  githubInstallationReposHandler,
  workspaceActivityHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import {
  upgradesFixture,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"
import { OrgHomePageContent } from "@/routes/$orgSlug.index"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceSettingsPane } from "./WorkspaceSettingsPane"
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
        // Only an owner or admin sees the repository pickers.
        role: [activeMemberRoleHandler("owner")],
        page: [
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler(),
        ],
        sources: [
          workspaceSourcesHandler(workspaceSourceList()),
          orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
        ],
        upgrades: [workspaceUpgradesHandler(upgradesFixture([]))],
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
 * Four groups in one column: General, Repositories, Connectors, and Danger
 * zone. The Connectors group shows three providers.
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
    const eyebrows = [
      "General",
      "Repositories",
      "Sources",
      "Upgrades",
      "Danger zone",
    ]
    const labels = [...canvasElement.querySelectorAll(".ctx-label")].map(
      (element) => element.textContent,
    )
    await expect(labels).toEqual(eyebrows)
    await expect(canvas.getByText("Can save changes")).toBeVisible()
    await expect(canvas.getByText("Ready")).toBeVisible()
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
      canvas.getByRole("heading", { level: 2, name: "Main repository" }),
    ).toBeVisible()
    await expect(
      canvas.getByRole("region", { name: "Sources" }),
    ).toBeInTheDocument()
    await expect(
      canvas.getByRole("link", { name: "Add another connection" }),
    ).toHaveAttribute("href", "/acme/connectors")
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Delete this Workspace" }),
    ).toBeVisible()
  },
}

export const SkippedFiles: Story = {
  args: {
    workspace: skippedFilesWorkspaceDetail,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Hydrate skipped 2 files")
    await canvas.findByText("Front matter is not valid")
    await canvas.findByText(
      "Repeats a linked repository or the Workspace's own repository",
    )
    expect(
      canvas.getByRole("link", { name: "knowledge/billing/tax.md" }),
    ).toBeVisible()
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
 * again" opens the main repository dialog, where Select GitHub binds it.
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
        within(dialog).getByRole("heading", { name: "Main repository" }),
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
 * The main repository picker and "Add repositories" share one cached
 * repository query. Opening one, then the other, lists the repositories.
 */
export const AddRepositories: Story = {
  args: {
    workspace: emptyLinkedWorkspaceDetail,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: /edit main repository/i }),
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

export const HydrateFailed: Story = {
  args: {
    workspace: failedHydrateWorkspaceDetail,
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Loading failed")
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
      canvas.getByRole("button", { name: /edit main repository/i }),
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
