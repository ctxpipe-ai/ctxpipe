import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"
import { githubInstallationLinkedHandler } from "@/mocks/handlers"
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
    await canvas.findByText(/no repository is free to use/i)
    await canvas.findByRole("link", { name: /change access/i })
  },
}

/**
 * The org has no GitHub connection. The tab offers "Connect GitHub" in
 * place, and "Paste a git URL" opens the Paste URL tab.
 */
export const NoGithubConnection: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          orgGithubConnectionsHandler([]),
          githubConnectorBootstrapHandler({
            orgSlug: "acme",
            hostedDefaultAppInstallUrl:
              "https://github.com/apps/ctxpipe/installations/new",
          }),
        ],
      },
    },
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

/**
 * The app sees only selected repositories. The steps prefill the owner on
 * GitHub, link to giving the app access, and "Select the repository" goes
 * back to the list.
 */
export const CreateOnGitHub: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          orgGithubConnectionsHandler(),
          githubInstallationReposHandler(),
          githubInstallationLinkedHandler,
        ],
      },
    },
  },
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
}

/** The app sees every repository, so no access step shows. */
export const CreateOnGitHubAllAccess: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          orgGithubConnectionsHandler(),
          githubInstallationReposHandler(undefined, {
            repositorySelection: "all",
          }),
          githubInstallationLinkedHandler,
        ],
      },
    },
  },
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
}

/** No GitHub connection: step 2 connects GitHub in place. */
export const CreateOnGitHubNoConnection: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          orgGithubConnectionsHandler([]),
          githubConnectorBootstrapHandler({
            orgSlug: "acme",
            hostedDefaultAppInstallUrl:
              "https://github.com/apps/ctxpipe/installations/new",
          }),
        ],
      },
    },
  },
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
}

export const PasteUrl: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("tab", { name: /paste url/i }))
  },
}

/** A Workspace in a folder of a larger repository: the root folder goes with the choice. */
export const PasteUrlWithRootFolder: Story = {
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
}

/** The root folder is optional: an empty field sends "" for the whole repository. */
export const PasteUrlWithEmptyRootFolder: Story = {
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
}

export const SaveError: Story = {
  args: {
    error: "That git URL is already used by another Workspace.",
  },
}
