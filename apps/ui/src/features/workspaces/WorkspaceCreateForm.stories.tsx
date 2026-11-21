import { delay, HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { Button } from "@/components/ui/Button"
import { githubAppInstalledHandlers, signedInHandlers } from "@/mocks/handlers"
import {
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
import {
  upgradesFixture,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import {
  createdWorkspace,
  createdWritableWorkspaceDetail,
} from "./workspace-fixtures"
import { WorkspaceCreateForm } from "./WorkspaceCreateForm"

const meta = preview.meta({
  title: "Components/Workspaces/CreateForm",
  component: WorkspaceCreateForm,
  decorators: [
    (Story) => (
      <div className="min-h-[28rem] bg-zinc-950 px-6 py-16">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    // Only an owner or admin sees the repository pickers.
    msw.use(
      ...signedInHandlers,
      activeMemberRoleHandler("owner"),
      workspaceListHandler([]),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
      githubInstallationReposHandler(),
      ...githubAppInstalledHandlers,
    )
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: { orgSlug: "acme" },
})

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

/**
 * Create form for a Workspace, where an owner picks the Workspace repository:
 * the org has no Workspaces, and step 1 is current.
 */
export const ZeroWorkspaces = meta.story({
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as SelectGitHub.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/saves this Workspace’s knowledge/)
    await expect(
      canvas.getByText("Choose the Workspace repository").closest("li"),
    ).toHaveAttribute("aria-current", "step")
    await canvas.findByRole("list", { name: /repositories/i })
  },
})

/**
 * Create form for a Workspace, where an owner picks the Workspace repository:
 * the list of GitHub repositories to choose from.
 */
export const SelectGitHub = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: /repositories/i })
  },
})

/**
 * Create form for a Workspace, where an owner picks the Workspace repository:
 * the Create on GitHub tab is open to make a new repository.
 */
export const CreateOnGitHub = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("tab", { name: /create on github/i }),
    )
  },
})

/**
 * Create form for a Workspace, where an owner picks the Workspace repository:
 * the create request failed, so an error says it could not save.
 */
export const SaveError = meta.story({
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
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([]),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
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
    )
  },
})

/**
 * Create form for a Workspace: the Workspace was created, and step 2 asks the
 * owner to add source repositories.
 */
export const AddSourcesAfterCreate = meta.story({
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
  beforeEach: ({ msw }) => {
    msw.use(
      ...stepTwoHandlers,
      workspaceDetailHandler(createdWritableWorkspaceDetail),
    )
  },
})

/**
 * Create form for a Workspace: the Workspace was created, and the write access
 * check finished, so the owner can add repositories.
 */
export const WaitsForWriteAccessCheck = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...stepTwoHandlers,
      http.get(
        ({ request }) =>
          /\/api\/v1\/workspaces\/[^/]+$/.test(new URL(request.url).pathname),
        () =>
          HttpResponse.json({
            ...createdWritableWorkspaceDetail,
            writeStatus: "unknown",
            conversationWritable: false,
          }),
        { once: true },
      ),
      workspaceDetailHandler(createdWritableWorkspaceDetail),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as AddSourcesAfterCreate.",
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
})

/**
 * Create form for a Workspace: the GitHub App cannot write to the new Workspace
 * repository, so it is read-only and only Open Workspace shows.
 */
export const ReadOnlyRepository = meta.story({
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
  beforeEach: ({ msw }) => {
    msw.use(
      ...stepTwoHandlers,
      workspaceDetailHandler({
        ...createdWritableWorkspaceDetail,
        writeStatus: "read_only",
        conversationWritable: false,
        readOnlyReason: "The GitHub App cannot write to this repository.",
      }),
    )
  },
})

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
 * Create form for a Workspace. The owner left the page while the create request
 * ran. The Workspace still exists, but the form does not call back, so it does
 * not change the page that the owner opened since.
 */
export const LeaveWhileCreating = meta.story({
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
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
  },
})
