import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { githubAppInstalledHandlers, signedInHandlers } from "@/mocks/handlers"
import {
  conversationsListHandler,
  githubInstallationReposHandler,
  workspaceCreateHandler,
  workspaceDetailHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import {
  upgradesFixture,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  createdWorkspace,
  createdWritableWorkspaceDetail,
  docsConversations,
  docsWorkspace,
  readOnlyWorkspace,
} from "./workspace-fixtures"
import { WorkspaceNavList } from "./WorkspaceNavList"

const meta = {
  title: "Components/Workspaces/NavList",
  component: WorkspaceNavList,
  decorators: [
    (Story) => (
      <ul className="w-64 bg-zinc-950 py-2">
        <Story />
      </ul>
    ),
  ],
  parameters: {
    msw: {
      handlers: {
        session: signedInHandlers,
        role: [activeMemberRoleHandler("admin")],
        ingestion: workspaceIngestionHandlers({}),
      },
    },
    app: "root",
    review: { kind: "component" },
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
    review: {
      purpose:
        "Workspace list in the side nav, where a member opens a Workspace or its chats: two Workspaces, and the current one shows its chats.",
    },
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
    review: {
      purpose:
        "Workspace list in the side nav, where a member opens a Workspace or its chats: the org has one Workspace with its chats.",
    },
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
    review: {
      purpose:
        "Workspace list in the side nav, where a member opens a Workspace or its chats: the org has no Workspaces yet.",
    },
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
    review: {
      purpose:
        "Workspace list in the collapsed side nav rail, where a member opens a Workspace: the Workspace list still loads.",
    },
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

// The first read of the Workspace list fails, then Retry reads it again.
let listReadFails = true

const loadFailsParameters = {
  msw: {
    handlers: {
      page: [
        http.get(
          ({ request }) =>
            /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
          () =>
            listReadFails
              ? HttpResponse.json({ error: "boom" }, { status: 500 })
              : HttpResponse.json({
                  items: [docsWorkspace],
                  lastUsedWorkspaceId: docsWorkspace.id,
                }),
        ),
        conversationsListHandler(docsConversations),
        githubInstallationReposHandler(),
      ],
    },
  },
}

export const LoadFails: Story = {
  beforeEach: () => {
    listReadFails = true
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as SingleWorkspace.",
    },
    ...loadFailsParameters,
    review: {
      purpose:
        "Workspace list in the side nav, where a member opens a Workspace or its chats: the first load failed, and Retry loaded the Workspace.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Could not load Workspaces.")
    listReadFails = false
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await canvas.findByText(docsWorkspace.displayName)
    await waitFor(() =>
      expect(canvas.queryByText("Could not load Workspaces.")).toBeNull(),
    )
  },
}

export const LoadFailsCollapsed: Story = {
  args: { expanded: false },
  beforeEach: () => {
    listReadFails = true
  },
  parameters: {
    ...loadFailsParameters,
    review: {
      purpose:
        "Workspace list in the collapsed side nav rail, where a member opens a Workspace: the first load failed, and Retry loaded the Workspace.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const retry = await canvas.findByRole("button", {
      name: "Retry loading Workspaces",
    })
    listReadFails = false
    await userEvent.click(retry)
    // The row has two links with this name: the title and the compose link.
    await canvas.findAllByRole("link", {
      name: `New conversation in ${docsWorkspace.displayName}`,
    })
    await waitFor(() =>
      expect(
        canvas.queryByRole("button", { name: "Retry loading Workspaces" }),
      ).toBeNull(),
    )
  },
}

export const AddWorkspace: Story = {
  parameters: {
    review: {
      purpose:
        "Workspace list in the side nav, where a member opens a Workspace or its chats: the Add Workspace dialog is open.",
    },
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
          orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
          ...githubAppInstalledHandlers,
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
    visual: {
      skip: "Behavior test: it ends in the same state as SingleWorkspace.",
    },
    review: {
      purpose:
        "Workspace list in the side nav: an owner created a Workspace in the Add Workspace dialog and opened it, so the dialog closed.",
    },
    msw: {
      handlers: {
        // Only an owner or admin sees the repository picker.
        role: [activeMemberRoleHandler("owner")],
        page: [
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
          orgConnectionsHandler([
            { id: "con_gh", type: "github", displayName: "acme" },
          ]),
          ...githubAppInstalledHandlers,
          githubInstallationReposHandler(),
          workspaceCreateHandler(createdWorkspace),
          workspaceDetailHandler(createdWritableWorkspaceDetail),
          workspaceSourcesHandler(workspaceSourceList()),
          workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
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
