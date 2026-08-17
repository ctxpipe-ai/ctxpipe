import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { userEvent, waitFor, within } from "storybook/test"
import {
  githubInstallationReposHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceCreateForm } from "./WorkspaceCreateForm"

const meta = {
  title: "Components/Workspaces/CreateForm",
  component: WorkspaceCreateForm,
  decorators: [
    (Story) => (
      <div className="min-h-[28rem] bg-zinc-950 px-6 py-16">
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
        page: [workspaceListHandler([]), githubInstallationReposHandler()],
      },
    },
  },
  args: { orgSlug: "acme" },
} satisfies Meta<typeof WorkspaceCreateForm>

export default meta

type Story = StoryObj<typeof meta>

export const ZeroWorkspaces: Story = {}

export const SelectGitHub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /select github/i }),
    )
  },
}

export const CreateOnGitHub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /create on github/i }),
    )
  },
}

export const SaveError: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([]),
          githubInstallationReposHandler(),
          http.post(
            ({ request }) =>
              /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
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
    await userEvent.type(
      canvas.getByLabelText(/git url/i),
      "https://github.com/acme/taken.git",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /create workspace/i }),
    )
    await waitFor(() => canvas.getByText(/could not save/i))
  },
}
