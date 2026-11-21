import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import {
  githubAppInstalledHandlers,
  githubAppMissingHandlers,
  githubInstallationLinkedHandler,
  signedInHandlers,
} from "@/mocks/handlers"
import {
  githubInstallationReposHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
} from "@/mocks/workspace-sources-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import { docsWorkspace } from "./workspace-fixtures"
import { WorkspaceRepositoryPicker } from "./WorkspaceRepositoryPicker"

const meta = preview.meta({
  title: "Components/Workspaces/RepositoryPicker",
  component: WorkspaceRepositoryPicker,
  decorators: [
    (Story) => (
      <div className="min-h-[28rem] w-full max-w-2xl bg-zinc-950 px-6 py-10">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    // Only an owner or admin sees the repository pickers.
    msw.use(
      ...signedInHandlers,
      activeMemberRoleHandler("owner"),
      workspaceListHandler([docsWorkspace]),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
      githubInstallationReposHandler(),
      ...githubAppInstalledHandlers,
    )
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    submitLabel: "Create Workspace",
    onSubmit: fn(),
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository: the
 * GitHub repository list still loads.
 */
export const Loading = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
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
    )
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository: the owner
 * picked a GitHub repository, so Create Workspace shows.
 */
export const SelectGitHub = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: /repositories/i })
    await canvas.findByRole("link", { name: /change access/i })
    // One Workspace repository: the rows are radios, and picking one reveals Create.
    expect(canvas.queryByRole("checkbox")).toBeNull()
    const [firstRadio] = canvas.getAllByRole("radio")
    if (!firstRadio) throw new Error("No repository radios rendered")
    await userEvent.click(firstRadio)
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: /create workspace/i }),
      ).toBeVisible(),
    )
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository: the
 * GitHub App sees no free repository, so the tab says how to give it access or
 * paste a URL.
 */
export const SelectGitHubEmpty = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/no repository is free to use/i)
    await canvas.findByRole("link", { name: /change access/i })
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
      githubInstallationReposHandler([]),
    )
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository. The org
 * has no GitHub connection, so the GitHub tab offers "Connect GitHub" in place.
 * The owner clicked "Paste a git URL", and the Paste URL tab is open.
 */
export const NoGithubConnection = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      orgConnectionsHandler([]),
      ...githubAppMissingHandlers,
    )
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as PasteUrl." },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "Connect GitHub" })
    await expect(
      canvas.getByRole("button", { name: "Connect GitHub" }),
    ).toBeVisible()
    await expect(canvas.queryByText(/ctxpipe has access to/)).toBeNull()
    await userEvent.click(
      canvas.getByRole("button", { name: "Paste a git URL" }),
    )
    await waitFor(() => expect(canvas.getByLabelText(/git url/i)).toBeVisible())
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository: the
 * GitHub App can see all repositories of the org.
 */
export const SelectGitHubAllAccess = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/all repositories/i)
    await canvas.findByRole("link", { name: /change access/i })
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
      githubInstallationReposHandler(undefined, {
        repositorySelection: "all",
      }),
    )
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository. The app
 * sees only selected repositories, so the Create on GitHub steps prefill the
 * owner on GitHub and link to the app access. The owner read the steps and
 * clicked "Select the repository" to go back to the list.
 */
export const CreateOnGitHub = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: /repositories/i })
    await userEvent.click(
      canvas.getByRole("tab", { name: /create on github/i }),
    )
    const create = await canvas.findByRole("link", {
      name: /create the repository on github/i,
    })
    const createUrl = new URL(create.getAttribute("href") ?? "")
    await expect(createUrl.origin + createUrl.pathname).toBe(
      "https://github.com/new",
    )
    await expect(createUrl.searchParams.get("owner")).toBe("acme")
    await expect(
      canvas.getByRole("link", { name: /give the ctxpipe github app access/i }),
    ).toHaveAttribute(
      "href",
      "https://github.com/apps/ctxpipe/installations/new",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Select the repository" }),
    )
    await expect(
      canvas.getByRole("tab", { name: /select github/i }),
    ).toHaveAttribute("aria-selected", "true")
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
      githubInstallationReposHandler(),
      githubInstallationLinkedHandler,
    )
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository. The
 * Create on GitHub tab has no access step, because the GitHub App sees all
 * repositories.
 */
export const CreateOnGitHubAllAccess = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: /repositories/i })
    await userEvent.click(
      canvas.getByRole("tab", { name: /create on github/i }),
    )
    await canvas.findByRole("link", {
      name: /create the repository on github/i,
    })
    await expect(
      canvas.queryByRole("link", {
        name: /give the ctxpipe github app access/i,
      }),
    ).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
      githubInstallationReposHandler(undefined, {
        repositorySelection: "all",
      }),
      githubInstallationLinkedHandler,
    )
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository. The org
 * has no GitHub connection, so in the Create on GitHub tab, step 2 connects
 * GitHub in place.
 */
export const CreateOnGitHubNoConnection = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("heading", { name: "Connect GitHub" })
    await userEvent.click(
      canvas.getByRole("tab", { name: /create on github/i }),
    )
    const create = await canvas.findByRole("link", {
      name: /create the repository on github/i,
    })
    await expect(
      new URL(create.getAttribute("href") ?? "").searchParams.has("owner"),
    ).toBe(false)
    await expect(
      canvas.getByRole("button", { name: "Connect GitHub" }),
    ).toBeVisible()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      orgConnectionsHandler([]),
      ...githubAppMissingHandlers,
    )
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository: the Paste
 * URL tab is open with an empty git URL field.
 */
export const PasteUrl = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("tab", { name: /paste url/i }))
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository. The owner
 * pasted a git URL with a root folder and clicked Create Workspace. The
 * Workspace is in a folder of a larger repository, so the root folder goes with
 * the choice.
 */
export const PasteUrlWithRootFolder = meta.story({
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText(/keep several workspaces in one repository/i),
      ).toBeVisible(),
    )
    await userEvent.type(
      canvas.getByRole("textbox", { name: /root folder/i }),
      "docs/context/",
    )
    await userEvent.click(canvas.getByRole("tab", { name: /paste url/i }))
    await userEvent.type(
      canvas.getByLabelText(/git url/i),
      "https://github.com/acme/platform.git",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /create workspace/i }),
    )
    await expect(args.onSubmit).toHaveBeenCalledWith({
      gitUrl: "https://github.com/acme/platform.git",
      source: "paste",
      rootPath: "docs/context",
    })
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository. The owner
 * pasted a git URL and left the optional root folder empty. The choice sends
 * "", so the Workspace uses the whole repository.
 */
export const PasteUrlWithEmptyRootFolder = meta.story({
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByPlaceholderText("Leave empty to use the whole repository"),
      ).toBeVisible(),
    )
    await userEvent.click(canvas.getByRole("tab", { name: /paste url/i }))
    await userEvent.type(
      canvas.getByLabelText(/git url/i),
      "https://github.com/acme/platform.git",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /create workspace/i }),
    )
    await expect(args.onSubmit).toHaveBeenCalledWith({
      gitUrl: "https://github.com/acme/platform.git",
      source: "paste",
      rootPath: "",
    })
  },
})

/**
 * Repository picker, where an owner chooses the Workspace repository: the save
 * failed because another Workspace already uses the git URL.
 */
export const SaveError = meta.story({
  args: {
    error: "That git URL is already used by another Workspace.",
  },
})

const memberRepoReads: string[] = []

/**
 * Repository picker, where a user chooses the Workspace repository. Only an
 * owner or admin can list the repositories of the GitHub App. For a member,
 * Select GitHub asks for an admin, and no tab reads the list. Paste URL still
 * works, and it is open.
 */
export const MemberAsksAnAdmin = meta.story({
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as PasteUrl." },
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("member"),
      workspaceListHandler([docsWorkspace]),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
      githubInstallationLinkedHandler,
      http.get(
        ({ request }) =>
          new URL(request.url).pathname.endsWith(
            "/api/v1/github/installation/repositories",
          ),
        ({ request }) => {
          memberRepoReads.push(new URL(request.url).pathname)
          return HttpResponse.json({ error: "Forbidden" }, { status: 403 })
        },
      ),
    )
    memberRepoReads.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(/Ask an admin to pick a GitHub repository/)
    await userEvent.click(
      canvas.getByRole("tab", { name: /create on github/i }),
    )
    await canvas.findByRole("link", {
      name: /create the repository on github/i,
    })
    await userEvent.click(canvas.getByRole("tab", { name: /select github/i }))
    await userEvent.click(
      await canvas.findByRole("button", { name: "Paste a git URL" }),
    )
    await waitFor(() =>
      expect(canvas.getByRole("tab", { name: /paste url/i })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    )
    expect(memberRepoReads).toEqual([])
  },
})
