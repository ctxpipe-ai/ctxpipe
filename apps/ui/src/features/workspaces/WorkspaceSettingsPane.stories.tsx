import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import {
  githubInstallationReposHandler,
  workspaceActivityHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
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
        page: [
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler(),
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

export const SkippedFiles: Story = {
  args: {
    workspace: skippedFilesWorkspaceDetail,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Hydrate skipped 2 files")
    await canvas.findByText("Front matter or git URL is not valid")
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

export const ProjectionLag: Story = {
  args: {
    workspace: projectionLagWorkspaceDetail,
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

export const AddRepositories: Story = {
  args: {
    workspace: emptyLinkedWorkspaceDetail,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /add repositories/i }),
    )
    const body = within(canvasElement.ownerDocument.body)
    await body.findByRole("dialog", { name: /add repositories/i })
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
      canvas.getByRole("button", { name: /edit workspace repository/i }),
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
    const name = canvas.getByRole("textbox", { name: /display name/i })
    await userEvent.clear(name)
    await userEvent.type(name, "Renamed Workspace")
    await userEvent.click(canvas.getByRole("button", { name: /^save$/i }))
    const body = within(canvasElement.ownerDocument.body)
    await body.findByText(/rename could not be scheduled/i)
    await expect(canvas.getByRole("textbox", { name: /^slug$/i })).toHaveValue(
      docsWorkspaceDetail.slug,
    )
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
    const confirm = scoped.getByRole("button", { name: "Delete Workspace" })
    expect(scoped.getByPlaceholderText("Docs")).toBeInTheDocument()
    await userEvent.type(scoped.getByLabelText("Workspace name"), "Wrong")
    expect(confirm).toBeDisabled()
    await userEvent.clear(scoped.getByLabelText("Workspace name"))
    await userEvent.type(scoped.getByLabelText("Workspace name"), "Docs")
    expect(confirm).toBeEnabled()
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
    const composer = await canvas.findByPlaceholderText(
      "Ask about this Workspace…",
    )
    await waitFor(() => expect(composer).toBeEnabled())
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
        canvas.getByPlaceholderText("Ask about this Workspace…"),
      ).toBeDisabled()
    })
    expect(
      canvas.getByRole("button", { name: "Create a workspace" }),
    ).toBeVisible()
  },
}
