import type { Meta, StoryObj } from "@storybook/react-vite"
import { useLocation } from "@tanstack/react-router"
import { delay, HttpResponse, http } from "msw"
import { useEffect, useState } from "react"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { responseGate } from "@/components/ui/skeletonMatchStory"
import { chatDraftKey, writeChatDraft } from "@/features/chat/chat-draft"
import {
  conversationDetailLoadingHandler,
  conversationGitDiffHandler,
  conversationGitStatusHandler,
  githubInstallationReposHandler,
  workspaceDetailErrorHandler,
  workspaceDetailLoadingHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"
import {
  ingestionItemFixture,
  workspaceIngestionHandlers,
} from "@/mocks/workspace-ingestion-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"
import { orgPageDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import type { IngestionItem } from "./ingestion"
import { WorkspaceSurface } from "./WorkspaceSurface"
import {
  docsConversationDetail,
  docsWorkspace,
  docsWorkspaceDetail,
  docsWorkspaceGitTree,
  failedHydrateWorkspace,
  failedHydrateWorkspaceDetail,
  hydratingWorkspaceDetail,
  readOnlyWorkspace,
  skippedFilesWorkspaceDetail,
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
  hash?: string
}): StoryRouteParams {
  return {
    pattern: "orgWorkspace",
    orgSlug,
    workspaceSlug,
    conversationId: input?.conversationId,
    pane: input?.pane,
    hash: input?.hash,
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
    // The story router renders its first route after an async load.
    await waitFor(
      () =>
        expect(
          canvas.getByRole("navigation", { name: "Main navigation" }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
    expect(canvas.getByText("Loading workspace")).toBeInTheDocument()
  },
}

const surfaceGate = responseGate()

const columnBox = (column: Element | null | undefined) => {
  if (!column) throw new Error("No workspace column")
  const { x, width, height } = column.getBoundingClientRect()
  return {
    x: Math.round(x),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * The surface skeleton has the same chat and pane columns as the loaded
 * workspace, so nothing moves when the workspace arrives.
 */
export const SurfaceSkeletonMatches: Story = {
  tags: ["workspace-golden"],
  args: { paneParam: "files" },
  parameters: {
    storyRoute: workspaceRoute({ pane: "files" }),
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            async () => {
              // No response: MSW falls through to the shell handler.
              await surfaceGate.wait()
            },
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const skeleton = (await canvas.findByText("Loading workspace"))
      .parentElement
    const chatBefore = columnBox(skeleton?.children[1])
    const paneBefore = columnBox(skeleton?.children[2])
    await surfaceGate.release()
    await waitFor(
      () =>
        expect(
          canvasElement.querySelector("[data-workspace-surface]"),
        ).not.toBeNull(),
      { timeout: 3000 },
    )
    const surface = canvasElement.querySelector("[data-workspace-surface]")
    expect(columnBox(surface?.children[0])).toEqual(chatBefore)
    expect(columnBox(surface?.children[1])).toEqual(paneBefore)
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

const failedTouch = { count: 0, rejections: [] as unknown[] }

/**
 * The last-used touch fails with 404, as it can for an old slug just after a
 * slug rename. The page stays, and the failure is not an uncaught error.
 */
export const FailedTouchIsCaught: Story = {
  tags: ["workspace-golden"],
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: [
          http.post(/\/api\/v1\/workspaces\/[^/]+\/touch$/, () => {
            failedTouch.count += 1
            return HttpResponse.json({ error: "Not found" }, { status: 404 })
          }),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  beforeEach: () => {
    failedTouch.count = 0
    failedTouch.rejections = []
    const onRejection = (event: PromiseRejectionEvent) => {
      failedTouch.rejections.push(event.reason)
    }
    window.addEventListener("unhandledrejection", onRejection)
    return () => window.removeEventListener("unhandledrejection", onRejection)
  },
  play: async () => {
    await waitFor(() => expect(failedTouch.count).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(failedTouch.rejections).toEqual([])
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

/**
 * A Workspace below the newest format (CTX-932): the banner stands at the top
 * of the page where the user works, with the next step. It is not only in
 * Settings.
 */
export const ComposeNeedsFormatUpgrade: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: [
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          activeMemberRoleHandler("owner"),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("This Workspace needs the format upgrade")
    await canvas.findByRole("button", { name: "Start the upgrade" })
    await expect(
      canvas.getByRole("link", { name: "Review upgrade" }),
    ).toHaveAttribute("href", "/acme/ws/docs?pane=settings#upgrades")
    // The chat stays usable below the banner.
    await expect(
      canvas.getByPlaceholderText(/what should ctxpipe do in this workspace/i),
    ).toBeVisible()
  },
}

/** The banner also stands above an open conversation. */
export const ConversationNeedsFormatUpgrade: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: [
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          activeMemberRoleHandler("member"),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("This Workspace needs the format upgrade")
    await waitFor(() => expect(canvas.getByText("Ask an admin")).toBeVisible())
    await expect(
      canvas.queryByRole("button", { name: "Start the upgrade" }),
    ).toBeNull()
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

/** The status of a sandbox that is on an older commit than the Workspace. */
function workspaceMovedStatus(ownChanges: boolean) {
  return conversationGitStatusHandler({
    source: "sandbox",
    branch: "ctxpipe/chat/conv_1/1",
    sha: "cdc935a0000000000000000000000000000000000",
    desiredSha: "3635994000000000000000000000000000000000",
    stale: true,
    workspaceMovedUnderChanges: ownChanges,
    dirty: ownChanges,
    differsFromDefault: ownChanges,
    unpushed: ownChanges,
    published: false,
    ahead: ownChanges ? 1 : 0,
    behind: 0,
    items: [],
    worktreeVersion: "wt-0",
  })
}

/**
 * The Workspace moved, but the conversation has no changes of its own. Its
 * next turn moves it to the new commit, so no notice shows.
 */
export const ConversationWorkspaceMovedNoChanges: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: [workspaceMovedStatus(false), ...workspaceShellHandlers()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The branch name shows when the status has loaded.
    await waitFor(() => expect(canvas.getByText("chat/1")).toBeVisible(), {
      timeout: 15_000,
    })
    expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    expect(canvas.queryByText(/rebase|conflict/i)).not.toBeInTheDocument()
  },
}

/**
 * The Workspace moved under the conversation's own changes. The notice says
 * to send a message first and does not name a conflict.
 */
export const ConversationWorkspaceMovedWithChanges: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: [workspaceMovedStatus(true), ...workspaceShellHandlers()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const notice = await waitFor(
      () => {
        const alert = canvas.getByRole("alert")
        expect(alert).toHaveTextContent("The Workspace has new commits")
        return alert
      },
      { timeout: 15_000 },
    )
    expect(notice).toHaveTextContent(
      "Send your next message to bring this conversation up to date. Then you can publish.",
    )
    expect(notice).not.toHaveTextContent(/conflict|rebase/i)
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
    await waitFor(() =>
      expect(
        canvas.getByRole("navigation", { name: "Main navigation" }),
      ).toBeVisible(),
    )
    // The whole-surface skeleton shows while the Workspace loads. It hands
    // over to the conversation's own skeleton, which stays: the conversation
    // never loads in this story.
    await waitFor(() => {
      expect(canvas.queryByText("Loading workspace")).not.toBeInTheDocument()
    })
    expect(canvasElement.querySelector("[data-skeleton]")).not.toBeNull()
    expect(
      canvas.queryByPlaceholderText(/continue the conversation/i),
    ).not.toBeInTheDocument()
    expect(canvas.queryByLabelText("Workspace files")).toBeNull()
    // The sibling nav stays populated while the conversation loads.
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: "Repo layout" })).toBeVisible(),
    )
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
    await canvas.findByPlaceholderText(
      "What should ctxpipe do in this Workspace?",
    )
    expect(canvas.queryByLabelText("Workspace files")).toBeNull()
    // The conversation list loads after the composer shows.
    await userEvent.click(
      await canvas.findByRole("link", { name: "Repo layout" }),
    )
    await waitFor(() => {
      expect(canvas.getByText("How is billing structured?")).toBeInTheDocument()
    })
    expect(canvas.queryByLabelText("Workspace files")).toBeNull()
    await userEvent.click(
      canvas.getByRole("link", { name: "New conversation in Docs" }),
    )
    await waitFor(() => {
      expect(
        canvas.getByPlaceholderText(
          "What should ctxpipe do in this Workspace?",
        ),
      ).toBeInTheDocument()
    })
    expect(canvas.queryByLabelText("Workspace files")).toBeNull()
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
    await canvas.findByPlaceholderText(
      "What should ctxpipe do in this Workspace?",
    )
    // The files pane mounts after the composer shows.
    await waitFor(() =>
      expect(canvas.getByLabelText("Workspace files")).toBeVisible(),
    )
    // The conversation list loads after the composer shows.
    await userEvent.click(
      await canvas.findByRole("link", { name: "Repo layout" }),
    )
    await waitFor(() => {
      expect(canvas.getByText("How is billing structured?")).toBeInTheDocument()
    })
    await waitFor(() =>
      expect(canvas.getByLabelText("Workspace files")).toBeVisible(),
    )
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

/** The conversation has no pull request yet, so its header shows Create PR. */
const noPrHandlers = () =>
  workspaceShellHandlers({
    conversation: {
      ...docsConversationDetail,
      conversation: {
        ...docsConversationDetail.conversation,
        lastChatPrNumber: null,
        lastChatPrUrl: null,
        prState: null,
      },
    },
  })

/** The branch is clean and ahead of the default branch: only Create PR shows. */
const cleanAheadStatus = () =>
  conversationGitStatusHandler({
    source: "sandbox",
    branch: "ctxpipe/chat/conv_1/1",
    dirty: false,
    differsFromDefault: true,
    unpushed: false,
    published: true,
    ahead: 1,
    behind: 0,
    items: [],
    worktreeVersion: "wt-0",
  })

/** A failed Sync shows why in a toast. */
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
          ...noPrHandlers(),
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
  },
}

/** A failed Create PR shows why in a toast. */
export const PublishPrErrorToast: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1", paneParam: "files" },
  decorators: PublishErrorsToast.decorators,
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
    msw: {
      handlers: {
        page: [
          http.post(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/pull-request$/.test(
                new URL(request.url).pathname,
              ),
            () => HttpResponse.json({ error: "no_pr_access" }, { status: 400 }),
          ),
          cleanAheadStatus(),
          ...noPrHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await page.findByRole(
        "button",
        { name: /create pr/i },
        { timeout: 15_000 },
      ),
    )
    await waitFor(
      () =>
        expect(
          page.getByText(
            "Create PR failed. The ctxpipe GitHub App can't open pull requests. Give it the Pull requests: Read and write permission.",
          ),
        ).toBeVisible(),
      { timeout: 10_000 },
    )
  },
}

/**
 * A successful Sync shows no toast. The thread reads the stored Sync again
 * and shows it after the last turn, with a link to the branch on GitHub.
 */
export const SyncAddsThreadEntry: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1" },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: (() => {
          let synced = false
          const branch = "ctxpipe/chat/conv_1/1"
          const treeUrl = `https://github.com/acme/docs/tree/${branch}`
          return [
            http.post(
              ({ request }) =>
                /\/api\/v1\/conversations\/[^/]+\/push$/.test(
                  new URL(request.url).pathname,
                ),
              () => {
                synced = true
                return HttpResponse.json({ branch, treeUrl })
              },
            ),
            http.get(
              ({ request }) =>
                /\/api\/v1\/conversations\/conv_1\/turns$/.test(
                  new URL(request.url).pathname,
                ),
              () =>
                HttpResponse.json({
                  items: [],
                  syncs: synced
                    ? [
                        {
                          trigger: "sync",
                          branch,
                          sha: "8eb1704c2d1f0a5b6e3c9d7f4a2b1c0d9e8f7a6b",
                          files: 3,
                          treeUrl,
                          turn: 1,
                          syncedAt: "2026-08-16T10:05:00.000Z",
                        },
                      ]
                    : [],
                }),
            ),
            ...workspaceShellHandlers(),
          ]
        })(),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const sync = await waitFor(
      () => {
        const button = page.getByRole("button", {
          name: "Sync: commit and push your changes",
        })
        expect(button).toBeEnabled()
        return button
      },
      { timeout: 15_000 },
    )
    await page.findByText("How is billing structured?", undefined, {
      timeout: 15_000,
    })
    expect(
      page.queryByRole("region", { name: /^Synced/ }),
    ).not.toBeInTheDocument()
    await userEvent.click(sync)
    const entry = await page.findByRole(
      "region",
      { name: "Synced 3 files to ctxpipe/chat/conv_1/1" },
      { timeout: 10_000 },
    )
    const link = within(entry).getByRole("link", {
      name: "ctxpipe/chat/conv_1/1 on GitHub (opens in a new tab)",
    })
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
    )
    expect(link).toHaveAttribute("target", "_blank")
    // The entry follows the reply of the last turn.
    const reply = page.getByText(/Billing lives in knowledge/)
    expect(
      reply.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // A successful Sync has no toast.
    expect(
      canvasElement.ownerDocument.querySelector("[data-sonner-toast]"),
    ).toBeNull()
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
      within(pane).queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
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
    await userEvent.click(page.getByRole("button", { name: "Maximize pane" }))
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

/**
 * Create PR shows once, at the top right of the conversation. It has the
 * git-pull-request icon, and the buttons there have no border.
 */
export const SingleCreatePr: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1", paneParam: "files" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
    msw: {
      handlers: {
        page: noPrHandlers(),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const visibleCreatePr = () =>
      page
        .getAllByRole("button", { name: "Create PR" })
        .filter((button) => !button.closest("[inert]"))
    const createPr = await waitFor(
      () => {
        const buttons = visibleCreatePr()
        expect(buttons).toHaveLength(1)
        expect(buttons[0]).toBeVisible()
        return buttons[0]
      },
      { timeout: 15_000 },
    )
    if (!createPr) throw new Error("Create PR is missing")
    const pane = canvasElement.ownerDocument.querySelector("aside")
    if (!pane) throw new Error("The tools pane is missing")
    // The tools pane is open beside the conversation: only the conversation header has Create PR.
    expect(createPr.closest("aside")).toBeNull()
    expect(
      createPr.querySelector("svg.tabler-icon-git-pull-request"),
    ).not.toBeNull()
    const actions = createPr.parentElement
    if (!actions) throw new Error("The publish actions are missing")
    for (const button of within(actions).getAllByRole("button"))
      expect(getComputedStyle(button).borderTopWidth).toBe("0px")
    // Maximized, the conversation is hidden: the pane header shows Create PR.
    await userEvent.click(page.getByRole("button", { name: "Maximize pane" }))
    await waitFor(() => {
      const buttons = visibleCreatePr()
      expect(buttons).toHaveLength(1)
      expect(buttons[0]?.closest("aside")).toBe(pane)
      expect(buttons[0]).toBeVisible()
    })
  },
}

/** With the tools pane closed, Create PR shows once, in the conversation header. */
export const SingleCreatePrPaneClosed: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: noPrHandlers(),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await waitFor(
      () => {
        const buttons = page.getAllByRole("button", { name: "Create PR" })
        expect(buttons).toHaveLength(1)
        expect(buttons[0]).toBeVisible()
        expect(
          buttons[0]?.querySelector("svg.tabler-icon-git-pull-request"),
        ).not.toBeNull()
      },
      { timeout: 15_000 },
    )
    // The pane triggers sit at the top right of the conversation too, with no visible border.
    for (const name of ["Files", "Graph", "Settings"])
      expect(
        getComputedStyle(page.getByRole("button", { name })).borderTopColor,
      ).toBe("rgba(0, 0, 0, 0)")
  },
}

/**
 * The pane is closed. Create PR and the pane triggers sit in the same header
 * row, and they look the same.
 */
export const CreatePrMatchesPaneTriggers: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: [cleanAheadStatus(), ...noPrHandlers()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const createPr = await page.findByRole(
      "button",
      { name: "Create PR" },
      { timeout: 15_000 },
    )
    const files = page.getByRole("button", { name: "Files" })
    await waitFor(() => expect(files).toBeVisible())
    // Both sit in the same header row.
    expect(createPr.closest("[data-workspace-surface]")).toBe(
      files.closest("[data-workspace-surface]"),
    )
    expect(createPr.closest("[data-workspace-surface]")).not.toBeNull()
    // The CTA button is smaller than a trigger, and both centers align.
    await document.fonts.ready
    const cta = createPr.getBoundingClientRect()
    const trigger = files.getBoundingClientRect()
    expect(cta.height).toBeLessThan(trigger.height)
    expect(cta.top + cta.height / 2).toBeCloseTo(
      trigger.top + trigger.height / 2,
      0,
    )
    // A trigger has the active tab box: 32px wide, 37px tall.
    expect(trigger.width).toBe(32)
    expect(trigger.height).toBe(37)
    expect(getComputedStyle(createPr).fontSize).toBe("12px")
    expect(getComputedStyle(createPr).fontWeight).toBe("400")
  },
}

/**
 * With the tools pane closed and the branch changed, the Diff trigger shows
 * beside Files, Graph and Settings, with the same style and the file-diff icon.
 */
export const DiffTriggerPaneClosed: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: [...workspaceShellHandlers(), conversationGitDiffHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    // The loading conversation also shows the pane triggers in its header.
    // When the conversation loads, new triggers replace them. A click on a
    // replaced trigger does nothing, so wait for the loaded conversation
    // before you find the trigger.
    await waitFor(
      () => expect(page.getByText("How is billing structured?")).toBeVisible(),
      { timeout: 15_000 },
    )
    // The trigger fades in for 100 ms when it mounts.
    await waitFor(
      () => expect(page.getByRole("button", { name: "Diff" })).toBeVisible(),
      { timeout: 15_000 },
    )
    const diff = page.getByRole("button", { name: "Diff" })
    const files = page.getByRole("button", { name: "Files" })
    expect(diff.parentElement).toBe(files.parentElement)
    expect(diff.className).toBe(files.className)
    expect(diff.querySelector("svg.tabler-icon-file-diff")).not.toBeNull()
    await userEvent.click(diff)
    // The click changes the route. The story router loads the pane after an
    // async load, the same slow step as the 15 s wait above. The tab then
    // fades in for 100 ms.
    await waitFor(
      () =>
        expect(
          page.getByRole("tab", { name: "Diff", selected: true }),
        ).toBeVisible(),
      { timeout: 15_000 },
    )
  },
}

/**
 * The Diff trigger shows with no changes on the branch, and its pane has an
 * empty state.
 */
export const DiffTriggerNoChanges: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1", paneParam: "files" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
    msw: {
      handlers: {
        page: [...workspaceShellHandlers(), conversationGitDiffHandler([])],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await page.findByRole("tab", { name: "Diff" }, { timeout: 15_000 }),
    )
    // Retry the whole check: a re-render can replace the found element.
    await waitFor(
      () => expect(page.getByText("No changes on this branch")).toBeVisible(),
      { timeout: 15_000 },
    )
  },
}

/**
 * A tab switch moves no tab. Each trigger keeps its box (x, y, width and
 * height) when another trigger becomes active. The tab that becomes active
 * keeps its x and width; it grows only to join the card.
 */
export const PaneTabsStayInPlace: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1", paneParam: "files" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
    msw: {
      handlers: {
        page: [...workspaceShellHandlers(), conversationGitDiffHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const names = ["Files", "Diff", "Graph", "Settings"]
    for (const name of names)
      await page.findByRole("tab", { name }, { timeout: 15_000 })
    await document.fonts.ready
    const boxes = () =>
      Object.fromEntries(
        names.map((name) => {
          const r = page.getByRole("tab", { name }).getBoundingClientRect()
          return [name, { x: r.x, y: r.y, width: r.width, height: r.height }]
        }),
      )
    // Let the fade-in of the tabs finish before the first read.
    await new Promise((resolve) => window.setTimeout(resolve, 200))
    for (const next of ["Diff", "Graph", "Settings", "Files"]) {
      const before = boxes()
      await userEvent.click(page.getByRole("tab", { name: next }))
      await page.findByRole("tab", { name: next, selected: true })
      await new Promise((resolve) => window.setTimeout(resolve, 200))
      const after = boxes()
      for (const name of names) {
        expect(after[name]?.x).toBe(before[name]?.x)
        expect(after[name]?.width).toBe(before[name]?.width)
        // The tab that becomes active, or stops being active, joins the card.
        if (name !== next && before[name]?.height === after[name]?.height) {
          expect(after[name]?.y).toBe(before[name]?.y)
        }
      }
    }
  },
}

/**
 * The Diff tab uses the file-diff icon. When it is active, the top-left
 * corner of the pane card is round, as it is when Graph is active.
 */
export const DiffTabRoundedCorner: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1", paneParam: "diff" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "diff" }),
    msw: {
      handlers: {
        page: [...workspaceShellHandlers(), conversationGitDiffHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const diff = await page.findByRole(
      "tab",
      { name: "Diff", selected: true },
      { timeout: 15_000 },
    )
    expect(diff.querySelector("svg.tabler-icon-file-diff")).not.toBeNull()
    const radius = () =>
      getComputedStyle(page.getByRole("tabpanel")).borderTopLeftRadius
    const diffRadius = radius()
    await userEvent.click(page.getByRole("tab", { name: "Graph" }))
    await page.findByRole("tab", { name: "Graph", selected: true })
    const graphRadius = radius()
    expect(graphRadius).not.toBe("0px")
    expect(diffRadius).toBe(graphRadius)
    // Files leads the strip, so its join stays square.
    await userEvent.click(page.getByRole("tab", { name: "Files" }))
    await waitFor(() => expect(radius()).toBe("0px"))
  },
}

/** The names of the visible publish actions in one header. */
const publishActionNames = (root: HTMLElement) =>
  within(root)
    .queryAllByRole("button", { name: /^(Sync|Create PR)/ })
    .concat(within(root).queryAllByRole("link", { name: /^Show PR/ }))
    .filter((element) => !element.closest("[inert]"))
    .map((element) => element.getAttribute("aria-label") ?? element.textContent)

/**
 * No sandbox runs and the branch is on GitHub. Maximized, the pane header
 * shows the same publish actions as the conversation header.
 */
export const MaximizedPaneMatchesHeader: Story = {
  tags: ["workspace-golden"],
  args: { conversationId: "conv_1", paneParam: "files" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/files\/status$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json(
                { error: "sandbox_not_running" },
                { status: 409 },
              ),
          ),
          ...noPrHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const document = canvasElement.ownerDocument
    const page = within(document.body)
    const header = await waitFor(
      () => {
        const createPr = page.getByRole("button", { name: "Create PR" })
        expect(createPr).toBeVisible()
        expect(createPr.closest("aside")).toBeNull()
        const actions = createPr.parentElement
        if (!actions) throw new Error("The publish actions are missing")
        return actions
      },
      { timeout: 15_000 },
    )
    const pane = document.querySelector("aside")
    if (!pane) throw new Error("The tools pane is missing")
    const headerNames = publishActionNames(header)
    await userEvent.click(page.getByRole("button", { name: "Maximize pane" }))
    await waitFor(() => {
      expect(publishActionNames(pane)).toEqual(headerNames)
      expect(
        within(pane).getByRole("button", { name: "Create PR" }),
      ).toBeVisible()
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
    await waitFor(() =>
      expect(
        page.getByPlaceholderText(/continue the conversation/i),
      ).toBeVisible(),
    )
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

/**
 * A link from Home lands on the Status group. Only the pane's own scroll
 * area moves: no outer box scrolls, so the pane keeps filling the panel.
 */
export const SettingsPaneLandsOnUpgrades: Story = {
  parameters: {
    storyRoute: workspaceRoute({ pane: "settings", hash: "upgrades" }),
    msw: {
      handlers: {
        page: [
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const group = await waitFor(() => {
      const found = canvasElement.querySelector<HTMLElement>(
        '[data-settings-group="Status"]',
      )
      expect(found).toHaveFocus()
      return found as HTMLElement
    })
    await document.fonts.ready
    const panel = group.closest<HTMLElement>('[role="tabpanel"]')
    const scroller = group.closest<HTMLElement>("[data-settings-scroll]")
    if (!panel || !scroller) throw new Error("The settings pane is missing")
    await waitFor(() => {
      // The panel has a 1px border.
      expect(
        panel.getBoundingClientRect().bottom -
          scroller.getBoundingClientRect().bottom,
      ).toBeLessThanOrEqual(2)
      for (
        let box = scroller.parentElement;
        box && box !== canvasElement.ownerDocument.body;
        box = box.parentElement
      ) {
        expect(box.scrollTop).toBe(0)
      }
    })
  },
}

/** Fix using agent fills the composer of a new conversation and keeps the settings pane open. */
export const FixUsingAgentOpensChat: Story = {
  parameters: {
    storyRoute: workspaceRoute({ pane: "settings" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers({ detail: skippedFilesWorkspaceDetail }),
      },
    },
  },
  beforeEach: () => {
    const key = chatDraftKey(orgSlug, docsWorkspace.id)
    writeChatDraft(key, "")
    return () => writeChatDraft(key, "")
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Fix knowledge/billing/tax.md using agent",
      }),
    )
    await waitFor(() =>
      expect(
        canvas.getByPlaceholderText(
          "What should ctxpipe do in this Workspace?",
        ),
      ).toHaveValue(
        "Hydrate skipped knowledge/billing/tax.md: Front matter is not valid. Fix the front matter of this file so that it is valid, then open the change.",
      ),
    )
    await expect(canvas.getByText("Workspace settings")).toBeVisible()
  },
}

const writeCheck = {
  phase: "failed" as "failed" | "checking" | "stuck",
  detailReads: 0,
  readsWhileChecking: 0,
}
const writeCheckFailedReason =
  "ctxpipe could not check write access because GitHub returned an error or a rate limit. Check again later."

/** Waits longer than two 2 s poll intervals, then proves no read happened. */
async function expectNoDetailPoll() {
  const reads = writeCheck.detailReads
  await new Promise((resolve) => setTimeout(resolve, 4500))
  await expect(writeCheck.detailReads).toBe(reads)
}

export const WriteCheckFailedStopsPolling: Story = {
  tags: ["workspace-golden"],
  args: { paneParam: "settings" },
  beforeEach: () => {
    writeCheck.phase = "failed"
    writeCheck.detailReads = 0
    writeCheck.readsWhileChecking = 0
  },
  parameters: {
    storyRoute: workspaceRoute({ pane: "settings" }),
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              writeCheck.detailReads += 1
              if (writeCheck.phase === "failed") {
                return HttpResponse.json({
                  ...docsWorkspaceDetail,
                  writeStatus: "unknown",
                  readOnlyReason: writeCheckFailedReason,
                })
              }
              // The new check resolves after two polls.
              writeCheck.readsWhileChecking += 1
              return HttpResponse.json({
                ...docsWorkspaceDetail,
                writeStatus:
                  writeCheck.readsWhileChecking > 2 ? "writable" : "unknown",
                readOnlyReason: null,
              })
            },
          ),
          http.post(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+\/check-write-access$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              writeCheck.phase = "checking"
              return HttpResponse.json({
                ...docsWorkspace,
                writeStatus: "unknown",
                readOnlyReason: null,
              })
            },
          ),
          ...workspaceShellHandlers(),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const alert = await waitFor(
      () => {
        const found = canvas
          .getAllByRole("alert")
          .find((el) =>
            el.textContent?.includes("Could not check write access"),
          )
        if (!found) throw new Error("The failed write check alert is missing")
        return found
      },
      { timeout: 10_000 },
    )
    await expect(alert).toHaveTextContent(writeCheckFailedReason)
    await expectNoDetailPoll()

    await userEvent.click(
      within(alert).getByRole("button", { name: "Check again" }),
    )
    await waitFor(
      () =>
        expect(canvas.getAllByText("Can save changes").length).toBeGreaterThan(
          0,
        ),
      { timeout: 10_000 },
    )
    await expect(canvas.queryByText("Could not check write access")).toBeNull()
    await expectNoDetailPoll()
  },
}

export const WriteCheckStallStopsPolling: Story = {
  tags: ["workspace-golden"],
  // A short cap, so the story does not wait three minutes.
  args: { paneParam: "settings", writeCheckPollCapMs: 3000 },
  beforeEach: () => {
    writeCheck.phase = "stuck"
    writeCheck.detailReads = 0
  },
  parameters: {
    storyRoute: workspaceRoute({ pane: "settings" }),
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              writeCheck.detailReads += 1
              return HttpResponse.json({
                ...docsWorkspaceDetail,
                writeStatus: "unknown",
                readOnlyReason: null,
              })
            },
          ),
          http.post(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+\/check-write-access$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json({
                ...docsWorkspace,
                writeStatus: "unknown",
                readOnlyReason: null,
              }),
          ),
          ...workspaceShellHandlers(),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const alert = await waitFor(
      () => {
        const found = canvas
          .getAllByRole("alert")
          .find((el) => el.textContent?.includes("Still checking write access"))
        if (!found) throw new Error("The stalled check alert is missing")
        return found
      },
      { timeout: 10_000 },
    )
    await expectNoDetailPoll()

    // Check again resets the timer, so polling starts again.
    const reads = writeCheck.detailReads
    await userEvent.click(
      within(alert).getByRole("button", { name: "Check again" }),
    )
    await waitFor(() => expect(writeCheck.detailReads).toBeGreaterThan(reads), {
      timeout: 10_000,
    })
    await waitFor(
      () =>
        expect(
          canvas
            .getAllByRole("alert")
            .some((el) =>
              el.textContent?.includes("Still checking write access"),
            ),
        ).toBe(true),
      { timeout: 10_000 },
    )
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

/**
 * Shows the Workspace until the URL is Home, as the real route tree does. The
 * real tree unmounts the Workspace a little after the router resolves, so this
 * stage keeps it for 1.5 s and renders it again every 100 ms.
 */
function DeleteFlowStage(props: React.ComponentProps<typeof WorkspaceSurface>) {
  const pathname = useLocation({ select: (location) => location.pathname })
  const home = pathname === `/${orgSlug}`
  const [unmounted, setUnmounted] = useState(false)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!home) return
    const timer = setTimeout(() => setUnmounted(true), 1500)
    // Any render of the Workspace that is still mounted, such as a poll.
    const tick = setInterval(() => setTick((n) => n + 1), 100)
    return () => {
      clearTimeout(timer)
      clearInterval(tick)
    }
  }, [home])
  if (home && unmounted) return <p>Home page</p>
  return <WorkspaceSurface {...props} />
}

/** The API after the delete: the Workspace routes answer 404, the list drops it. */
function deleteFlowHandlers(remaining: (typeof docsWorkspace)[]) {
  let deleted = false
  const path = (request: Request) => new URL(request.url).pathname
  return [
    http.get(
      ({ request }) =>
        deleted &&
        (/\/api\/v1\/workspaces\/ws_docs|\/api\/v1\/workspaces\/docs(\/|$)/.test(
          path(request),
        ) ||
          request.url.includes("workspaceId=ws_docs") ||
          /\/api\/v1\/conversations\/[^/]+/.test(path(request))),
      () => HttpResponse.json({ error: "not found" }, { status: 404 }),
    ),
    http.get(
      ({ request }) => deleted && /\/api\/v1\/workspaces$/.test(path(request)),
      () =>
        HttpResponse.json({
          items: remaining,
          lastUsedWorkspaceId: remaining[0]?.id ?? null,
        }),
    ),
    http.delete(
      ({ request }) => /\/api\/v1\/workspaces\/[^/]+$/.test(path(request)),
      () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      },
    ),
    workspaceSourcesHandler(workspaceSourceList()),
    workspaceUpgradesHandler(upgradesFixture([])),
    orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
    githubInstallationReposHandler(),
    ...workspaceShellHandlers({ workspaces: [docsWorkspace, ...remaining] }),
  ]
}

/** Deletes the open Workspace and records every error the page shows on the way. */
async function deleteOpenWorkspace(canvasElement: HTMLElement) {
  const body = within(canvasElement.ownerDocument.body)
  const seen: string[] = []
  const scan = () => {
    for (const text of [
      "Something went wrong",
      "Could not load",
      "Workspace not found",
    ]) {
      if (canvasElement.ownerDocument.body.textContent?.includes(text))
        seen.push(text)
    }
  }
  const observer = new MutationObserver(scan)
  observer.observe(canvasElement.ownerDocument.body, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  await userEvent.click(
    await body.findByRole("button", { name: "Delete Workspace" }),
  )
  const dialog = await body.findByRole("alertdialog")
  await userEvent.type(within(dialog).getByLabelText("Workspace name"), "Docs")
  await userEvent.keyboard("{Enter}")
  await waitFor(() => expect(body.queryByRole("alertdialog")).toBeNull())
  await within(canvasElement).findByText("Home page", {}, { timeout: 5000 })
  scan()
  observer.disconnect()
  await expect(seen).toEqual([])
  await waitFor(() => expect(body.getByText("Workspace deleted")).toBeVisible())
  await expect(within(canvasElement).getByText("Home page")).toBeVisible()
}

const deleteFlowDecorators = [
  (Story: () => React.ReactElement) => (
    <>
      <Story />
      <Toaster />
    </>
  ),
]

/** Deleting the open Workspace goes Home with a toast and no error page. */
export const DeleteWorkspaceShowsNoError: Story = {
  tags: ["workspace-golden"],
  args: { paneParam: "settings" },
  render: (args) => <DeleteFlowStage {...args} />,
  decorators: deleteFlowDecorators,
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: `/${orgSlug}/ws/${workspaceSlug}`,
      alsoAt: [`/${orgSlug}`],
    } satisfies StoryRouteParams,
    msw: { handlers: { page: deleteFlowHandlers([readOnlyWorkspace]) } },
  },
  play: ({ canvasElement }) => deleteOpenWorkspace(canvasElement),
}

/** The same, when the Workspace is the last one. */
export const DeleteLastWorkspaceShowsNoError: Story = {
  ...DeleteWorkspaceShowsNoError,
  tags: ["workspace-golden"],
  play: ({ canvasElement }) => deleteOpenWorkspace(canvasElement),
  parameters: {
    ...DeleteWorkspaceShowsNoError.parameters,
    msw: { handlers: { page: deleteFlowHandlers([]) } },
  },
}

/** The same, from a conversation URL. */
export const DeleteFromConversationShowsNoError: Story = {
  ...DeleteWorkspaceShowsNoError,
  tags: ["workspace-golden"],
  play: ({ canvasElement }) => deleteOpenWorkspace(canvasElement),
  args: { paneParam: "settings", conversationId: "conv_1" },
  parameters: {
    ...DeleteWorkspaceShowsNoError.parameters,
    storyRoute: {
      pattern: "flat",
      path: `/${orgSlug}/ws/${workspaceSlug}/conv_1`,
      alsoAt: [`/${orgSlug}`],
    } satisfies StoryRouteParams,
  },
}

let demoStart = 0

/**
 * The ingestion state of the demo at `seconds` after the story starts: a
 * repository run in its shards, a Linear sync, a second run that waits for
 * the first one and a slow hydrate, then idle. The demo starts with work,
 * because the sidebar reads an idle org only once a minute.
 */
function ingestionDemoState(seconds: number): Record<string, IngestionItem[]> {
  if (seconds >= 30) return {}
  const startedAt = (ago: number) =>
    new Date(demoStart + (4 - ago) * 1000).toISOString()
  const shards = Math.max(0, Math.min(8, Math.floor((seconds - 7) / 2)))
  return {
    docs: [
      ingestionItemFixture({
        stage:
          seconds < 7 ? "planning" : shards < 8 ? "ingesting" : "publishing",
        progress:
          seconds < 7 || shards === 8
            ? null
            : { done: shards, total: 8, unit: "shards" },
        startedAt: startedAt(95),
      }),
      ingestionItemFixture({
        id: "run_web_2",
        stage: "waiting",
        progress: null,
        startedAt: startedAt(40),
      }),
      ...(seconds < 14
        ? [
            ingestionItemFixture({
              id: "run_linear",
              kind: "source_sync",
              name: "Linear",
              stage: null,
              progress: null,
              startedAt: startedAt(12),
            }),
          ]
        : []),
      ...(seconds >= 14 && seconds < 22
        ? [
            ingestionItemFixture({
              id: "run_hydrate",
              kind: "hydrate",
              name: null,
              stage: null,
              progress: null,
              startedAt: startedAt(34),
            }),
          ]
        : []),
    ],
  }
}

/**
 * The demo of CTX-959 for a video: the sidebar shows the ingesting dot,
 * Workspace settings shows the progress move, and the list empties when the
 * work ends (about 30 s). The state changes with time, on each read.
 */
export const IngestingDemo: Story = {
  beforeEach: () => {
    demoStart = Date.now()
  },
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: [
          workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
          workspaceSourcesHandler(workspaceSourceList()),
          orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
          activeMemberRoleHandler("owner"),
          githubInstallationReposHandler(),
          ...workspaceShellHandlers(),
        ],
        ingestion: workspaceIngestionHandlers(() =>
          ingestionDemoState((Date.now() - demoStart) / 1000),
        ),
      },
    },
  },
}
