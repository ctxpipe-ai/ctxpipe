import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceSettingsPane } from "./WorkspaceSettingsPane"
import { docsWorkspaceDetail } from "./workspace-fixtures"

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
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspaceDetail,
  },
} satisfies Meta<typeof WorkspaceSettingsPane>

export default meta

type Story = StoryObj<typeof meta>

export const Settings: Story = {}

export const DeleteConfirmOpen: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
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
    await userEvent.type(scoped.getByLabelText("Workspace name"), "Wrong")
    expect(confirm).toBeDisabled()
    await userEvent.clear(scoped.getByLabelText("Workspace name"))
    await userEvent.type(scoped.getByLabelText("Workspace name"), "Docs")
    expect(confirm).toBeEnabled()
  },
}
