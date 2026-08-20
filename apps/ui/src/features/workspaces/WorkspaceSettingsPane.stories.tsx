import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  githubInstallationReposHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
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
  },
} satisfies Meta<typeof WorkspaceSettingsPane>

export default meta

type Story = StoryObj<typeof meta>

export const Settings: Story = {}

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
  },
}
