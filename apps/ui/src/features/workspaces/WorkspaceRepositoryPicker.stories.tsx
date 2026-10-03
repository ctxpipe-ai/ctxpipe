import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { fn, userEvent, within } from "storybook/test"
import {
  githubInstallationReposHandler,
  orgGithubConnectionsHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceRepositoryPicker } from "./WorkspaceRepositoryPicker"
import { docsWorkspace } from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/RepositoryPicker",
  component: WorkspaceRepositoryPicker,
  decorators: [
    (Story) => (
      <div className="min-h-[28rem] w-full max-w-2xl bg-zinc-950 px-6 py-10">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          orgGithubConnectionsHandler(),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  args: {
    orgSlug: "acme",
    submitLabel: "Create Workspace",
    onSubmit: fn(),
  },
} satisfies Meta<typeof WorkspaceRepositoryPicker>

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          orgGithubConnectionsHandler(),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/github/installation/repositories",
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json({ repositories: [] })
            },
          ),
        ],
      },
    },
  },
}

export const SelectGitHub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: /repositories/i })
    await canvas.findByRole("link", { name: /change access/i })
  },
}

export const SelectGitHubEmpty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          orgGithubConnectionsHandler(),
          githubInstallationReposHandler([]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/no installation repositories/i)
    await canvas.findByRole("link", { name: /change access/i })
  },
}

export const SelectGitHubAllAccess: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          orgGithubConnectionsHandler(),
          githubInstallationReposHandler(undefined, {
            repositorySelection: "all",
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/all repositories/i)
    await canvas.findByRole("link", { name: /change access/i })
  },
}

export const CreateOnGitHub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("tab", { name: /create on github/i }),
    )
    await canvas.findByRole("button", { name: /open github/i })
  },
}

export const PasteUrl: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("tab", { name: /paste url/i }))
  },
}

export const SaveError: Story = {
  args: {
    error: "That git URL is already used by another Workspace.",
  },
}
