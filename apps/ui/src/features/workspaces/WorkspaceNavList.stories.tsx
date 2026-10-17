import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  conversationsListHandler,
  githubInstallationReposHandler,
  workspaceCreateHandler,
  workspaceDetailHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceNavList } from "./WorkspaceNavList"
import {
  createdWorkspace,
  createdWritableWorkspaceDetail,
  docsConversations,
  docsWorkspace,
  readOnlyWorkspace,
} from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/NavList",
  component: WorkspaceNavList,
  decorators: [
    (Story) => (
      <ul className="w-64 bg-zinc-950 py-2">
        <Story />
      </ul>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    expanded: true,
    currentWorkspaceSlug: "docs",
    onSelectNav: () => {},
  },
} satisfies Meta<typeof WorkspaceNavList>

export default meta

type Story = StoryObj<typeof meta>

export const MultipleWorkspaces: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
}

export const SingleWorkspace: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
}

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [workspaceListHandler([]), githubInstallationReposHandler()],
      },
    },
  },
}

export const Loading: Story = {
  args: { expanded: false },
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
            async () => {
              await delay("infinite")
              return HttpResponse.json({
                items: [],
                lastUsedWorkspaceId: null,
              })
            },
          ),
        ],
      },
    },
  },
}

export const AddWorkspace: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add Workspace" }),
    )
    const dialog = await within(canvasElement.ownerDocument.body).findByRole(
      "dialog",
    )
    await waitFor(() =>
      expect(
        within(dialog).getByRole("heading", { name: "Add Workspace" }),
      ).toBeVisible(),
    )
  },
}

export const AddWorkspaceThenRepositories: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          // Only an owner or admin sees the repository picker.
          activeMemberRoleHandler("owner"),
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
          orgConnectionsHandler([
            { id: "con_gh", type: "github", displayName: "acme" },
          ]),
          githubInstallationReposHandler(),
          workspaceCreateHandler(createdWorkspace),
          workspaceDetailHandler(createdWritableWorkspaceDetail),
          workspaceSourcesHandler(workspaceSourceList()),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add Workspace" }),
    )
    const wizard = within(await body.findByRole("dialog"))
    await userEvent.click(
      await wizard.findByRole("radio", { name: /acme\/handbook/ }),
    )
    await userEvent.click(
      wizard.getByRole("button", { name: "Create Workspace" }),
    )
    // Step 2 opens a second dialog over the wizard.
    await userEvent.click(
      await wizard.findByRole("button", { name: "Add repositories" }),
    )
    await body.findByRole("heading", { name: "Add repositories" })
    await userEvent.click(body.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(
        body.queryByRole("heading", { name: "Add repositories" }),
      ).toBeNull(),
    )
    // Opening the new Workspace changes the page, which closes the wizard.
    await userEvent.click(
      wizard.getByRole("button", { name: "Open Workspace" }),
    )
    await waitFor(() => expect(body.queryByRole("dialog")).toBeNull())
  },
}
