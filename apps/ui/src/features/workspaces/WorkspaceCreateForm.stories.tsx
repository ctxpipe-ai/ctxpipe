import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { Button } from "@/components/ui/Button"
import {
  githubInstallationReposHandler,
  orgGithubConnectionsHandler,
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
import {
  upgradesFixture,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  createdWorkspace,
  createdWritableWorkspaceDetail,
} from "./workspace-fixtures"
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
        // Only an owner or admin sees the repository pickers.
        role: [activeMemberRoleHandler("owner")],
        page: [
          workspaceListHandler([]),
          orgGithubConnectionsHandler(),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  args: { orgSlug: "acme" },
} satisfies Meta<typeof WorkspaceCreateForm>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Step 2 needs the new Workspace, its sources, a GitHub connection, and a
 * Workspace repository that is ready for sources (format 3).
 */
const stepTwoHandlers = [
  workspaceListHandler([]),
  orgConnectionsHandler([
    { id: "con_gh", type: "github", displayName: "acme" },
  ]),
  githubInstallationReposHandler(),
  workspaceCreateHandler(createdWorkspace),
  workspaceSourcesHandler(workspaceSourceList()),
  workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
]

async function createFromGithub(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.click(
    await canvas.findByRole("radio", { name: /acme\/handbook/ }),
  )
  await userEvent.click(
    canvas.getByRole("button", { name: "Create Workspace" }),
  )
}

export const ZeroWorkspaces: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/saves this Workspace’s knowledge/)
    await expect(
      canvas.getByText("Choose the Workspace repository").closest("li"),
    ).toHaveAttribute("aria-current", "step")
    await canvas.findByRole("list", { name: /repositories/i })
  },
}

export const SelectGitHub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: /repositories/i })
  },
}

export const CreateOnGitHub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("tab", { name: /create on github/i }),
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
    await userEvent.click(canvas.getByRole("tab", { name: /paste url/i }))
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

export const AddSourcesAfterCreate: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          ...stepTwoHandlers,
          workspaceDetailHandler(createdWritableWorkspaceDetail),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await createFromGithub(canvasElement)
    await canvas.findByRole("button", { name: "Add repositories" })
    // With nothing chosen, "Add repositories" is the one primary button.
    await waitFor(() => {
      expect(
        canvas.getByRole("button", { name: "Add repositories" }),
      ).toHaveClass("bg-primary")
      expect(
        canvas.getByRole("button", { name: "Open Workspace" }),
      ).not.toHaveClass("bg-primary")
    })
    await expect(
      canvas.getByText("Add code repositories and tools").closest("li"),
    ).toHaveAttribute("aria-current", "step")
    await expect(
      canvas.getByText("Choose the Workspace repository").closest("li"),
    ).toHaveAttribute("data-state", "done")
    await expect(
      canvas.getByRole("link", { name: "Add another connection" }),
    ).toHaveAttribute("href", "/acme/connectors")
    // NavList AddWorkspaceThenRepositories covers "Open Workspace". A click
    // here would leave this story on an empty route.
    await expect(
      canvas.getByRole("button", { name: "Open Workspace" }),
    ).toBeVisible()
  },
}

export const WaitsForWriteAccessCheck: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          ...stepTwoHandlers,
          // The first answer has the check running; the next has it done.
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json({
                ...createdWritableWorkspaceDetail,
                writeStatus: "unknown",
                conversationWritable: false,
              }),
            { once: true },
          ),
          workspaceDetailHandler(createdWritableWorkspaceDetail),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await createFromGithub(canvasElement)
    await canvas.findByText("Checking write access")
    await expect(canvas.queryByText("Read-only")).toBeNull()
    await canvas.findByRole(
      "button",
      { name: "Add repositories" },
      { timeout: 5000 },
    )
    await expect(canvas.queryByText("Checking write access")).toBeNull()
  },
}

export const ReadOnlyRepository: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          ...stepTwoHandlers,
          workspaceDetailHandler({
            ...createdWritableWorkspaceDetail,
            writeStatus: "read_only",
            conversationWritable: false,
            readOnlyReason: "The GitHub App cannot write to this repository.",
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await createFromGithub(canvasElement)
    await canvas.findByText("Read-only")
    await expect(
      canvas.getByText("The GitHub App cannot write to this repository."),
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "Add repositories" }),
    ).toBeNull()
    await expect(
      canvas.getByRole("button", { name: "Open Workspace" }),
    ).toBeVisible()
  },
}

/** How many times the create call finished. A play reads it to know the answer came. */
const slowCreate = { answered: 0 }

/** A page that shows the form, and that the user can leave. */
function LeavablePage(props: { orgSlug: string }) {
  const [open, setOpen] = useState(true)
  const [created, setCreated] = useState(0)
  return (
    <>
      <Button onPress={() => setOpen(false)}>Leave</Button>
      <output>Created calls: {created}</output>
      {open ? (
        <WorkspaceCreateForm
          orgSlug={props.orgSlug}
          onCreated={() => setCreated((count) => count + 1)}
        />
      ) : null}
    </>
  )
}

/**
 * The user leaves the page while the create call runs. The Workspace still
 * exists, but the form must not change the page that the user opened since.
 */
export const LeaveWhileCreating: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(
            ({ request }) =>
              /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
            async () => {
              await delay(500)
              slowCreate.answered += 1
              return HttpResponse.json(createdWorkspace, { status: 201 })
            },
          ),
          ...stepTwoHandlers,
        ],
      },
    },
  },
  render: (args) => <LeavablePage orgSlug={args.orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    slowCreate.answered = 0
    await createFromGithub(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Leave" }))
    await waitFor(() => expect(slowCreate.answered).toBe(1))
    // Give the query client time to run a late callback, if the form has one.
    await delay(300)
    await expect(canvas.getByText("Created calls: 0")).toBeVisible()
  },
}
