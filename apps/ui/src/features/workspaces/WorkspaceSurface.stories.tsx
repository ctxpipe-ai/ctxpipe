import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  conversationDetailLoadingHandler,
  conversationGitDiffHandler,
  githubInstallationReposHandler,
  workspaceDetailErrorHandler,
  workspaceDetailLoadingHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"
import { orgPageDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceSurface } from "./WorkspaceSurface"
import {
  docsConversationDetail,
  docsWorkspace,
  docsWorkspaceGitTree,
  failedHydrateWorkspace,
  failedHydrateWorkspaceDetail,
  hydratingWorkspaceDetail,
  readOnlyWorkspace,
  waitingForTipWorkspaceDetail,
} from "./workspace-fixtures"

const orgSlug = "acme"
const workspaceSlug = "docs"

const meta = {
  title: "Pages/Workspaces",
  component: WorkspaceSurface,
  decorators: [...orgPageDecorators],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    orgSlug,
    workspaceSlug,
  },
} satisfies Meta<typeof WorkspaceSurface>

export default meta

type Story = StoryObj<typeof meta>

function workspaceRoute(input?: {
  conversationId?: string
  pane?: string
}): StoryRouteParams {
  return {
    pattern: "orgWorkspace",
    orgSlug,
    workspaceSlug,
    conversationId: input?.conversationId,
    pane: input?.pane,
  }
}

export const Loading: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: [workspaceDetailLoadingHandler(), ...workspaceShellHandlers()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    expect(canvas.getByText("Loading workspace")).toBeInTheDocument()
  },
}

export const NotFound: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: workspaceShellHandlers({ detail: null }),
      },
    },
  },
}

export const LoadError: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: [workspaceDetailErrorHandler(), ...workspaceShellHandlers()],
      },
    },
  },
}

export const Hydrating: Story = {
  args: { workspaceSlug: "knowledge" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "knowledge",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: workspaceShellHandlers({
          workspaces: [hydratingWorkspaceDetail, docsWorkspace],
          detail: hydratingWorkspaceDetail,
        }),
      },
    },
  },
}

export const WaitingForTip: Story = {
  args: { workspaceSlug: "waiting-tip" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "waiting-tip",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: workspaceShellHandlers({
          workspaces: [waitingForTipWorkspaceDetail, docsWorkspace],
          detail: waitingForTipWorkspaceDetail,
        }),
      },
    },
  },
}

export const PrepareFailed: Story = {
  args: { workspaceSlug: "knowledge-failed" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "knowledge-failed",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.post(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+\/retry-prepare$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json({
                ...failedHydrateWorkspace,
                hydrateStatus: "pending",
                hydrateError: null,
              }),
          ),
          ...workspaceShellHandlers({
            workspaces: [failedHydrateWorkspace, docsWorkspace],
            detail: failedHydrateWorkspaceDetail,
          }),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
}

export const Compose: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const Conversation: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const ConversationLoading: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: [conversationDetailLoadingHandler(), ...workspaceShellHandlers()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    expect(canvas.queryByRole("list", { name: "Workspace files" })).toBeNull()
    expect(canvas.queryByText("Loading workspace")).not.toBeInTheDocument()
  },
}

export const ConversationNavIsChatOnly: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Ask about this Workspace.")
    expect(canvas.queryByRole("list", { name: "Workspace files" })).toBeNull()
    await userEvent.click(canvas.getByRole("link", { name: "Repo layout" }))
    await waitFor(() => {
      expect(canvas.getByText("How is billing structured?")).toBeInTheDocument()
    })
    expect(canvas.queryByRole("list", { name: "Workspace files" })).toBeNull()
    await userEvent.click(
      canvas.getByRole("link", { name: "New conversation in Docs" }),
    )
    await waitFor(() => {
      expect(canvas.getByText("Ask about this Workspace.")).toBeInTheDocument()
    })
    expect(canvas.queryByRole("list", { name: "Workspace files" })).toBeNull()
    expect(canvas.queryByText("Loading workspace")).not.toBeInTheDocument()
  },
}

export const ConversationKeepsExplicitPaneSearch: Story = {
  parameters: {
    storyRoute: workspaceRoute({ pane: "files" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Ask about this Workspace.")
    expect(canvas.getByRole("list", { name: "Workspace files" })).toBeVisible()
    await userEvent.click(canvas.getByRole("link", { name: "Repo layout" }))
    await waitFor(() => {
      expect(canvas.getByText("How is billing structured?")).toBeInTheDocument()
    })
    expect(canvas.getByRole("list", { name: "Workspace files" })).toBeVisible()
  },
}

export const ConversationMissing: Story = {
  args: { conversationId: "conv_missing" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_missing" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers({ conversation: null }),
      },
    },
  },
}

/** A failed Sync or Create PR shows why in a toast. */
export const PublishErrorsToast: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1", paneParam: "files" },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
    msw: {
      handlers: {
        page: [
          http.post(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/push$/.test(
                new URL(request.url).pathname,
              ),
            () => HttpResponse.json({ error: "turn_running" }, { status: 409 }),
          ),
          http.post(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/pull-request$/.test(
                new URL(request.url).pathname,
              ),
            () => HttpResponse.json({ error: "no_pr_access" }, { status: 400 }),
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const enabledButton = async (name: RegExp) => {
      let found: HTMLElement | undefined
      await waitFor(
        () => {
          found = page
            .getAllByRole("button", { name })
            .filter(
              (button) =>
                button.getAttribute("aria-disabled") !== "true" &&
                !button.hasAttribute("disabled"),
            )
            .at(-1)
          expect(found).toBeDefined()
        },
        { timeout: 15_000 },
      )
      if (!found) throw new Error(`No enabled button ${name}`)
      return found
    }
    await userEvent.click(await enabledButton(/^sync/i))
    // The toast fades in.
    await waitFor(
      () =>
        expect(
          page.getByText(
            "Sync failed. The agent is still working. Try again when the turn ends.",
          ),
        ).toBeVisible(),
      { timeout: 10_000 },
    )
    await userEvent.click(await enabledButton(/create pr/i))
    // The toast fades in.
    await waitFor(
      () =>
        expect(
          page.getByText(
            "Create PR failed. The ctx| GitHub App can't open pull requests. Give it the Pull requests: Read and write permission.",
          ),
        ).toBeVisible(),
      { timeout: 10_000 },
    )
  },
}

/**
 * Sync shows once: in the conversation header while the tools pane is open
 * beside it, and in the pane header when the pane is maximized. Both share
 * one pending push.
 */
export const SharedPublishPending: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1", paneParam: "files" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
    msw: {
      handlers: {
        page: [
          http.post(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/push$/.test(
                new URL(request.url).pathname,
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json({
                branch: "ctxpipe/chat/conv_1/1",
                treeUrl:
                  "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
              })
            },
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const syncName = "Sync: commit and push your changes"
    // The tools pane is open beside the conversation: Sync shows once, in the
    // conversation header. The pane header has none.
    const sync = await waitFor(
      () => {
        const buttons = page.getAllByRole("button", { name: syncName })
        expect(buttons).toHaveLength(1)
        expect(buttons[0]).toBeEnabled()
        return buttons[0]
      },
      { timeout: 15_000 },
    )
    const pane = canvasElement.ownerDocument.querySelector("aside")
    if (!pane) throw new Error("The tools pane is missing")
    expect(sync.closest("aside")).toBeNull()
    expect(sync).toHaveTextContent("Sync")
    expect(
      within(pane).queryByRole("button", { name: /^Sync/ }),
    ).not.toBeInTheDocument()
    expect(
      within(pane).getByRole("button", { name: "Create PR" }),
    ).toBeVisible()
    await userEvent.click(sync)
    const pendingName = "Syncing: commit and push in progress"
    await waitFor(
      () => {
        expect(page.getByRole("button", { name: pendingName })).toHaveAttribute(
          "data-pending",
          "true",
        )
      },
      { timeout: 15_000 },
    )
    // Maximized, the pane hides the conversation and shows Sync, still pending.
    // Testing Library ignores `inert`, so skip the hidden conversation column's Sync.
    await userEvent.click(page.getByRole("button", { name: "Maximise pane" }))
    await waitFor(() => {
      const all = page.getAllByRole("button", { name: pendingName })
      for (const button of all.filter((b) => b.closest("[inert]")))
        expect(button).not.toBeVisible()
      const pending = all.filter((button) => !button.closest("[inert]"))
      expect(pending).toHaveLength(1)
      expect(pending[0]?.closest("aside")).toBe(pane)
      expect(pending[0]).toHaveAttribute("data-pending", "true")
    })
  },
}

const idleBudget = { conversation: 0, tree: 0, status: 0, chat: 0, diff: 0 }

export const StableRequestBudget: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1", paneParam: "files" },
  decorators: [
    (Story) => (
      <div className="min-h-svh w-[1280px] max-w-none">
        <Story />
      </div>
    ),
  ],
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              idleBudget.conversation += 1
              return HttpResponse.json(docsConversationDetail)
            },
          ),
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/tree$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              idleBudget.tree += 1
              return HttpResponse.json({
                ...docsWorkspaceGitTree,
                branch: "ctxpipe/chat/conv_1/1",
                worktreeVersion: "wt-0",
              })
            },
          ),
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/status$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              idleBudget.status += 1
              return HttpResponse.json({
                source: "sandbox",
                branch: "ctxpipe/chat/conv_1/1",
                dirty: true,
                differsFromDefault: true,
                unpushed: true,
                published: false,
                ahead: 1,
                behind: 0,
                items: [],
                worktreeVersion: "wt-0",
              })
            },
          ),
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/chat$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              idleBudget.chat += 1
              return HttpResponse.json({
                messages: docsConversationDetail.messages,
                activeRun: null,
              })
            },
          ),
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/diff$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              idleBudget.diff += 1
              return HttpResponse.json({
                items: [
                  {
                    path: "knowledge/billing/ledger.md",
                    oldBody: "old",
                    body: "new",
                  },
                ],
              })
            },
          ),
          conversationGitDiffHandler(),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    idleBudget.conversation = 0
    idleBudget.tree = 0
    idleBudget.status = 0
    idleBudget.chat = 0
    idleBudget.diff = 0
    const page = within(canvasElement.ownerDocument.body)
    expect(
      await page.findByPlaceholderText(/continue the conversation/i),
    ).toBeVisible()
    await waitFor(
      () => {
        expect(
          page.getAllByRole("button", {
            name: "Sync: commit and push your changes",
          }).length,
        ).toBeGreaterThan(0)
      },
      { timeout: 10_000 },
    )
    const diffTabs = page.queryAllByRole("tab", { name: "Diff" })
    if (diffTabs[0]) await userEvent.click(diffTabs[0])
    await waitFor(() => {
      expect(idleBudget.tree).toBeGreaterThan(0)
      expect(idleBudget.status).toBeGreaterThan(0)
      expect(idleBudget.conversation).toBeGreaterThan(0)
      expect(idleBudget.chat + idleBudget.diff).toBeGreaterThan(0)
    })
    let frozen = { ...idleBudget }
    const drainUntil = Date.now() + 3_000
    for (;;) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 250)
      })
      if (JSON.stringify(idleBudget) === JSON.stringify(frozen)) break
      frozen = { ...idleBudget }
      if (Date.now() >= drainUntil) break
    }
    frozen = { ...idleBudget }
    await new Promise((resolve) => {
      window.setTimeout(resolve, 800)
    })
    expect(idleBudget).toEqual(frozen)
  },
}

export const FilesPane: Story = {
  args: { paneParam: "files" },
  parameters: {
    storyRoute: workspaceRoute({ pane: "files" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const GraphPane: Story = {
  args: { paneParam: "graph" },
  parameters: {
    storyRoute: workspaceRoute({ pane: "graph" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const SettingsPane: Story = {
  args: { paneParam: "settings" },
  parameters: {
    storyRoute: workspaceRoute({ pane: "settings" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers({
          workspaces: [docsWorkspace, readOnlyWorkspace],
        }),
      },
    },
  },
}

export const ReadOnly: Story = {
  args: { workspaceSlug: "handbook" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "handbook",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: workspaceShellHandlers({
          workspaces: [docsWorkspace, readOnlyWorkspace],
          detail: { ...readOnlyWorkspace, linkedRepositories: [] },
        }),
      },
    },
  },
}
