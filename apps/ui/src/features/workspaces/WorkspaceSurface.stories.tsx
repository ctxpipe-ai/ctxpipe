import { useLocation } from "@tanstack/react-router"
import { delay, HttpResponse, http } from "msw"
import { useEffect, useState } from "react"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { responseGate } from "@/components/ui/skeletonMatchStory"
import { chatDraftKey, writeChatDraft } from "@/features/chat/chat-draft"
import { waitForGraphReady } from "@/features/knowledge-graph/graphReadyStory"
import { signedInHandlers } from "@/mocks/handlers"
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

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import type { IngestionItem } from "./ingestion"
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
import { WorkspaceSurface } from "./WorkspaceSurface"

const orgSlug = "acme"
const workspaceSlug = "docs"

const meta = preview.meta({
  title: "Pages/Workspaces",
  tags: ["page"],
  component: WorkspaceSurface,
  beforeEach: ({ msw }) => {
    msw.use(
      ...signedInHandlers,
      activeMemberRoleHandler("admin"),
      ...workspaceIngestionHandlers({}),
    )
  },
  parameters: {
    app: "org",
    layout: "fullscreen",
    route: "/$orgSlug/ws/$workspaceSlug",
    review: { kind: "page" },
  },
  args: {
    orgSlug,
    workspaceSlug,
  },
})

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

/**
 * Workspace page in the org shell, where a member chats with the agent and
 * opens the tools pane: the Workspace detail is still loading.
 */
export const Loading = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(workspaceDetailLoadingHandler(), ...workspaceShellHandlers())
  },
  parameters: {
    storyRoute: workspaceRoute(),
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
})

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
 * Workspace page in the org shell, with the Files pane open. The loading
 * skeleton has the same chat and pane columns as the loaded page, so nothing
 * moves when the Workspace arrives.
 */
export const SurfaceSkeletonMatches = meta.story({
  tags: ["required"],
  args: { paneParam: "files" },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          /\/api\/v1\/workspaces\/[^/]+$/.test(new URL(request.url).pathname),
        async () => {
          // No response: MSW falls through to the shell handler.
          await surfaceGate.wait()
        },
      ),
      ...workspaceShellHandlers(),
    )
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as FilesPane." },
    intent:
      "Catches a workspace loading skeleton whose chat and pane columns differ from the loaded layout. This causes layout shift. Not for workspace data.",
    storyRoute: workspaceRoute({ pane: "files" }),
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
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * Workspace does not exist, so a not found state shows.
 */
export const NotFound = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers({ detail: null }))
  },
  parameters: {
    storyRoute: workspaceRoute(),
  },
})

const failedTouch = { count: 0, rejections: [] as unknown[] }

/**
 * Workspace page in the org shell, where a member chats with the agent. The
 * last-used request fails with 404, as it can for an old slug just after a slug
 * rename. The page stays, and the failure is not an uncaught error.
 */
export const FailedTouchIsCaught = meta.story({
  tags: ["required"],
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Compose." },
    intent:
      "Catches a failed workspace touch request that raises an unhandled promise rejection. The page must catch the 404. Not for visible errors or touch success.",
    storyRoute: workspaceRoute(),
  },
  beforeEach: ({ msw }) => {
    msw.use(
      http.post(/\/api\/v1\/workspaces\/[^/]+\/touch$/, () => {
        failedTouch.count += 1
        return HttpResponse.json({ error: "Not found" }, { status: 404 })
      }),
      ...workspaceShellHandlers(),
    )
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
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * Workspace detail did not load, so an error state shows.
 */
export const LoadError = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(workspaceDetailErrorHandler(), ...workspaceShellHandlers())
  },
  parameters: {
    storyRoute: workspaceRoute(),
  },
})

/**
 * Workspace page in the org shell, where a member chats with the agent: ctxpipe
 * still reads the repository into this Workspace for the first time.
 */
export const Hydrating = meta.story({
  args: { workspaceSlug: "knowledge" },
  beforeEach: ({ msw }) => {
    msw.use(
      ...workspaceShellHandlers({
        workspaces: [hydratingWorkspaceDetail, docsWorkspace],
        detail: hydratingWorkspaceDetail,
      }),
    )
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "knowledge",
    } satisfies StoryRouteParams,
  },
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * Workspace waits for the newest commit of its branch.
 */
export const WaitingForTip = meta.story({
  args: { workspaceSlug: "waiting-tip" },
  beforeEach: ({ msw }) => {
    msw.use(
      ...workspaceShellHandlers({
        workspaces: [waitingForTipWorkspaceDetail, docsWorkspace],
        detail: waitingForTipWorkspaceDetail,
      }),
    )
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "waiting-tip",
    } satisfies StoryRouteParams,
  },
})

/**
 * Workspace page in the org shell, where a member chats with the agent: ctxpipe
 * could not read the repository, so Prepare failed shows Try again and the raw
 * reason beside the settings.
 */
export const PrepareFailed = meta.story({
  args: { workspaceSlug: "knowledge-failed" },
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "knowledge-failed",
    } satisfies StoryRouteParams,
  },
})

/**
 * Workspace page in the org shell, where a member chats with the agent: no
 * conversation is open, so the composer for a new conversation shows.
 */
export const Compose = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers())
  },
  parameters: {
    route: "/$orgSlug/ws/$workspaceSlug/",
    storyRoute: workspaceRoute(),
  },
})

/**
 * Workspace page in the org shell, with the new conversation composer. The
 * Workspace is below the newest format, so a banner at the top of the page
 * offers to start the upgrade (CTX-932). The banner is where the user works,
 * not only in Settings.
 */
export const ComposeNeedsFormatUpgrade = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("owner"),
      workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
      ...workspaceShellHandlers(),
    )
  },
  parameters: {
    route: "/$orgSlug/ws/$workspaceSlug/",
    storyRoute: workspaceRoute(),
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
})

/**
 * Workspace page in the org shell, with an open conversation. The Workspace
 * needs the format upgrade, so the banner stands above the conversation and
 * tells a member to ask an admin.
 */
export const ConversationNeedsFormatUpgrade = meta.story({
  args: { conversationId: "conv_1" },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("member"),
      workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
      ...workspaceShellHandlers(),
    )
  },
  parameters: {
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("This Workspace needs the format upgrade")
    await waitFor(() => expect(canvas.getByText("Ask an admin")).toBeVisible())
    await expect(
      canvas.queryByRole("button", { name: "Start the upgrade" }),
    ).toBeNull()
  },
})

/**
 * Workspace page in the org shell, where a member chats with the agent: a
 * stored conversation is open with its messages.
 */
export const Conversation = meta.story({
  args: { conversationId: "conv_1" },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers())
  },
  parameters: {
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
  },
})

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
 * Workspace page in the org shell, with an open conversation. The Workspace has
 * new commits, but the conversation has no changes of its own. Its next turn
 * moves it to the new commit, so no notice shows.
 */
export const ConversationWorkspaceMovedNoChanges = meta.story({
  args: { conversationId: "conv_1" },
  beforeEach: ({ msw }) => {
    msw.use(workspaceMovedStatus(false), ...workspaceShellHandlers())
  },
  parameters: {
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The header has the branch name when the status has loaded. A phone
    // hides the branch label, so the check is for the name in the page.
    await waitFor(
      () => expect(canvas.getByText("chat/1")).toBeInTheDocument(),
      { timeout: 15_000 },
    )
    expect(canvas.queryByRole("alert")).not.toBeInTheDocument()
    expect(canvas.queryByText(/rebase|conflict/i)).not.toBeInTheDocument()
  },
})

/**
 * Workspace page in the org shell, with an open conversation. The Workspace has
 * new commits under the changes of the conversation. A notice says to send a
 * message first, and it does not name a conflict.
 */
export const ConversationWorkspaceMovedWithChanges = meta.story({
  args: { conversationId: "conv_1" },
  beforeEach: ({ msw }) => {
    msw.use(workspaceMovedStatus(true), ...workspaceShellHandlers())
  },
  parameters: {
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
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
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * conversation is still loading, and its title link shows.
 */
export const ConversationLoading = meta.story({
  args: { conversationId: "conv_1" },
  beforeEach: ({ msw }) => {
    msw.use(conversationDetailLoadingHandler(), ...workspaceShellHandlers())
  },
  parameters: {
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
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
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * user opens a conversation from the nav, and the tools pane stays closed.
 */
export const ConversationNavIsChatOnly = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers())
  },
  parameters: {
    visual: {
      // At the mobile width the screenshot is the same as Compose.
      viewports: ["desktop"],
    },
    storyRoute: workspaceRoute(),
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
})

/**
 * Workspace page in the org shell, with the Files pane open: the user opens a
 * conversation, and the Files pane stays open.
 */
export const ConversationKeepsExplicitPaneSearch = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers())
  },
  parameters: {
    storyRoute: workspaceRoute({ pane: "files" }),
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
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * conversation does not exist, so a not found state shows.
 */
export const ConversationMissing = meta.story({
  args: { conversationId: "conv_missing" },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers({ conversation: null }))
  },
  parameters: {
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_missing" }),
  },
})

/**
 * True when the viewport is at least `width` wide. From `lg` (64rem) up, the
 * conversation and the open tools pane show side by side. Below `lg`, the
 * open pane hides the conversation and has no Maximize: the pane header
 * shows the conversation title and the publish actions. Below `md` (48rem),
 * the pane fills the viewport.
 */
const minWidth = (canvasElement: HTMLElement, width: "48rem" | "64rem") =>
  canvasElement.ownerDocument.defaultView?.matchMedia(`(min-width: ${width})`)
    .matches ?? true

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

/**
 * Workspace page in the org shell, with a conversation and the Files pane open.
 * The member pressed Sync during a turn, so the push failed, and an error toast
 * says why.
 */
export const PublishErrorsToast = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1", paneParam: "files" },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(
      http.post(
        ({ request }) =>
          /\/api\/v1\/conversations\/[^/]+\/push$/.test(
            new URL(request.url).pathname,
          ),
        () => HttpResponse.json({ error: "turn_running" }, { status: 409 }),
      ),
      ...noPrHandlers(),
    )
  },
  parameters: {
    intent:
      "Catches a failed push that shows no error to the user. A rejected push must show a toast with the cause. Not for a successful push or PR creation.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
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
})

/**
 * Workspace page in the org shell, with a conversation and the Files pane open.
 * Create PR failed because a GitHub App permission is missing, and a toast says
 * why.
 */
export const PublishPrErrorToast = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1", paneParam: "files" },
  decorators: PublishErrorsToast.input.decorators,
  beforeEach: ({ msw }) => {
    msw.use(
      http.post(
        ({ request }) =>
          /\/api\/v1\/conversations\/[^/]+\/pull-request$/.test(
            new URL(request.url).pathname,
          ),
        () => HttpResponse.json({ error: "no_pr_access" }, { status: 400 }),
      ),
      cleanAheadStatus(),
      ...noPrHandlers(),
    )
  },
  parameters: {
    intent:
      "Catches a failed pull request creation that shows no error to the user. A rejected request must show a toast with the cause. Not for push errors.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
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
})

/**
 * Workspace page in the org shell, with an open conversation. The member
 * pressed Sync and the push succeeded, so no toast shows. The thread reads the
 * stored Sync again and adds a push entry after the last turn, with a link to
 * the branch on GitHub.
 */
export const SyncAddsThreadEntry = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1" },
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  beforeEach: ({ msw }) => {
    let synced = false
    const branch = "ctxpipe/chat/conv_1/1"
    const treeUrl = `https://github.com/acme/docs/tree/${branch}`
    msw.use(
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
    )
  },
  parameters: {
    intent:
      "Catches a successful sync that adds no entry to the conversation. The thread shows a push entry that links the branch. Not for failed syncs or PRs.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
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
})

/**
 * Workspace page in the org shell, with a conversation and the Files pane open.
 * A Sync push runs, and each Sync button shows the same pending state. Sync is
 * in the conversation header when the pane is beside it, and in the pane header
 * when the pane is maximized.
 */
export const SharedPublishPending = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1", paneParam: "files" },
  beforeEach: ({ msw }) => {
    msw.use(
      http.post(
        ({ request }) =>
          /\/api\/v1\/conversations\/[^/]+\/push$/.test(
            new URL(request.url).pathname,
          ),
        async () => {
          await delay("infinite")
          return HttpResponse.json({
            branch: "ctxpipe/chat/conv_1/1",
            treeUrl: "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
          })
        },
      ),
      ...workspaceShellHandlers(),
    )
  },
  parameters: {
    visual: {
      allow: {
        overflow: "A layout defect on main (CTX-1279).",
      },
    },
    intent:
      "Catches two publish buttons that do not share one pending state. While a push runs, every Sync button is pending and disabled. Not for push results.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
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
    const pendingName = "Syncing: commit and push in progress"
    if (!minWidth(canvasElement, "64rem")) {
      // The open pane hides the conversation: Sync shows once, in the pane
      // header. Hide the pane: the conversation header shows the same
      // pending push.
      expect(sync.closest("aside")).toBe(pane)
      expect(sync).toHaveTextContent("Sync")
      await userEvent.click(sync)
      await waitFor(
        () => {
          const pending = page.getByRole("button", { name: pendingName })
          expect(pending.closest("aside")).toBe(pane)
          expect(pending).toHaveAttribute("data-pending", "true")
        },
        { timeout: 15_000 },
      )
      await userEvent.click(
        within(pane).getByRole("button", { name: "Hide pane" }),
      )
      await waitFor(() => {
        const pending = page.getByRole("button", { name: pendingName })
        expect(pending.closest("aside")).toBeNull()
        expect(pending).toBeVisible()
        expect(pending).toHaveAttribute("data-pending", "true")
      })
      return
    }
    expect(sync.closest("aside")).toBeNull()
    expect(sync).toHaveTextContent("Sync")
    expect(
      within(pane).queryByRole("button", { name: /^Sync/ }),
    ).not.toBeInTheDocument()
    expect(
      within(pane).queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
    await userEvent.click(sync)
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
})

/**
 * Workspace page in the org shell, with a conversation and the Files pane open.
 * Create PR shows one time, at the top right of the conversation header, with
 * its git-pull-request icon. The buttons there have no border.
 */
export const SingleCreatePr = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1", paneParam: "files" },
  beforeEach: ({ msw }) => {
    // Clean and ahead: Create PR is the only publish action. A dirty
    // status adds Sync when it loads.
    msw.use(cleanAheadStatus(), ...noPrHandlers())
  },
  parameters: {
    intent:
      "Catches a second Create PR button when the pane is open. Only the conversation header has the button. Not for a closed pane or PR creation.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
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
    expect(
      createPr.querySelector("svg.tabler-icon-git-pull-request"),
    ).not.toBeNull()
    const actions = createPr.parentElement
    if (!actions) throw new Error("The publish actions are missing")
    for (const button of within(actions).getAllByRole("button"))
      expect(getComputedStyle(button).borderTopWidth).toBe("0px")
    if (minWidth(canvasElement, "64rem")) {
      // The tools pane is open beside the conversation: only the conversation
      // header has Create PR.
      expect(createPr.closest("aside")).toBeNull()
      // Maximized, the conversation is hidden: the pane header shows Create PR.
      await userEvent.click(page.getByRole("button", { name: "Maximize pane" }))
    }
    // The pane header shows Create PR and the conversation title, which
    // comes when the conversation list loads.
    await waitFor(() => {
      const buttons = visibleCreatePr()
      expect(buttons).toHaveLength(1)
      expect(buttons[0]?.closest("aside")).toBe(pane)
      expect(buttons[0]).toBeVisible()
      expect(
        within(pane).getByRole("button", { name: "Repo layout" }),
      ).toBeVisible()
    })
  },
})

/**
 * Workspace page in the org shell, with an open conversation and the tools pane
 * closed. The branch is synced and has no pull request, so Create PR shows one
 * time, in the conversation header.
 */
export const SingleCreatePrPaneClosed = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1" },
  beforeEach: ({ msw }) => {
    // Clean and ahead: Create PR is the only publish action. A dirty
    // status adds Sync when it loads.
    msw.use(cleanAheadStatus(), ...noPrHandlers())
  },
  parameters: {
    intent:
      "Catches a closed pane that hides Create PR or shows it twice. One button shows with a PR icon, and pane triggers have no border. Not for an open pane.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
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
})

/**
 * Workspace page in the org shell, with the tools pane closed. Create PR and
 * the pane triggers sit in one header row, and they look the same.
 */
export const CreatePrMatchesPaneTriggers = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1" },
  beforeEach: ({ msw }) => {
    msw.use(cleanAheadStatus(), ...noPrHandlers())
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as SingleCreatePrPaneClosed.",
    },
    intent:
      "Catches a Create PR button that sits in another row from the pane triggers, or has the wrong size. It shares the header row and is smaller. Not for PR creation.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
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
    // A trigger has the active tab box: 38px wide, 37px tall.
    expect(trigger.width).toBe(38)
    expect(trigger.height).toBe(37)
    expect(getComputedStyle(createPr).fontSize).toBe("12px")
    expect(getComputedStyle(createPr).fontWeight).toBe("400")
  },
})

/**
 * Workspace page in the org shell, with the tools pane closed. The branch
 * changed, so a Diff trigger with the file-diff icon shows beside Files, Graph,
 * and Settings, in the same style.
 */
export const DiffTriggerPaneClosed = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1" },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers(), conversationGitDiffHandler())
  },
  parameters: {
    intent:
      "Catches a Diff trigger that is missing from a closed pane, or styled unlike the Files trigger. Both share one parent and class. Not for the diff content.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
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
})

/**
 * Workspace page in the org shell, with a conversation and the tools pane open.
 * The branch has no changes, but the Diff tab still shows. The member opened
 * it, and the Diff pane has the empty state "No changes on this branch".
 */
export const DiffTriggerNoChanges = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1", paneParam: "files" },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers(), conversationGitDiffHandler([]))
  },
  parameters: {
    intent:
      "Catches a Diff tab on a branch with no changes that shows a blank pane. It shows that there are no changes on the branch. Not for diffs with files.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
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
})

/**
 * Workspace page in the org shell, with a conversation and the Files pane open.
 * The member switched pane tabs and came back to Files, and no tab moved. Each
 * trigger keeps its x, y, width, and height. The active tab grows only to join
 * the card.
 */
export const PaneTabsStayInPlace = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1", paneParam: "files" },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers(), conversationGitDiffHandler())
  },
  parameters: {
    intent:
      "Catches a tab switch that moves other tabs. Each trigger keeps its box and the new active tab keeps its x and width. Not for tab content.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    const names = ["Files", "Diff", "Graph", "Settings"]
    for (const name of names)
      await page.findByRole("tab", { name }, { timeout: 15_000 })
    await document.fonts.ready
    // Below `lg` the strip can be narrower than its tabs. Then it scrolls
    // the selected tab into view, which moves all tabs together. Add the
    // scroll offset, so that only a move inside the strip counts.
    const boxes = () =>
      Object.fromEntries(
        names.map((name) => {
          const tab = page.getByRole("tab", { name })
          const r = tab.getBoundingClientRect()
          const scrolled = tab.closest('[role="tablist"]')?.scrollLeft ?? 0
          return [
            name,
            { x: r.x + scrolled, y: r.y, width: r.width, height: r.height },
          ]
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
})

/**
 * Workspace page in the org shell, with a conversation and the Diff pane open.
 * The Diff tab has the file-diff icon. When it is active, the top-left corner
 * of the pane card is round, as it is when Graph is active.
 */
export const DiffTabRoundedCorner = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1", paneParam: "diff" },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers(), conversationGitDiffHandler())
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as PaneTabsStayInPlace.",
    },
    intent:
      "Catches a wrong joined corner on the pane card. The Diff and Graph tabs give the same rounded corner, and the first tab, Files, keeps it square. Not for tab content.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "diff" }),
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
    // Below `md` the pane fills the viewport, and its card has no radius.
    const flush = !minWidth(canvasElement, "48rem")
    if (flush) expect(graphRadius).toBe("0px")
    else expect(graphRadius).not.toBe("0px")
    expect(diffRadius).toBe(graphRadius)
    // Files leads the strip, so its join stays square.
    await userEvent.click(page.getByRole("tab", { name: "Files" }))
    await waitFor(() => expect(radius()).toBe("0px"))
  },
})

/**
 * The names of the publish actions in one header. With `hidden`, also in a
 * header that CSS hides.
 */
const publishActionNames = (root: HTMLElement, hidden = false) =>
  within(root)
    .queryAllByRole("button", { name: /^(Sync|Create PR)/, hidden })
    .concat(within(root).queryAllByRole("link", { name: /^Show PR/, hidden }))
    .filter((element) => !element.closest("[inert]"))
    .map((element) => element.getAttribute("aria-label") ?? element.textContent)

/**
 * Workspace page in the org shell, with a conversation and the Files pane
 * maximized. No sandbox runs and the branch is on GitHub, so the pane header
 * has the same Create PR action as the conversation header.
 */
export const MaximizedPaneMatchesHeader = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1", paneParam: "files" },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          /\/api\/v1\/conversations\/[^/]+\/files\/status$/.test(
            new URL(request.url).pathname,
          ),
        () =>
          HttpResponse.json({ error: "sandbox_not_running" }, { status: 409 }),
      ),
      ...noPrHandlers(),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as SingleCreatePr.",
    },
    intent:
      "Catches a maximized pane whose header differs from the conversation header. The Create PR call to action shows in the pane header with the same layout. Not for PR creation.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
  },
  play: async ({ canvasElement }) => {
    const document = canvasElement.ownerDocument
    const page = within(document.body)
    const wide = minWidth(canvasElement, "64rem")
    // Below `lg` the open pane hides the conversation header. It is still in
    // the document, so read its actions there.
    const header = await waitFor(
      () => {
        const createPr = wide
          ? page.getByRole("button", { name: "Create PR" })
          : page
              .getAllByRole("button", { name: "Create PR", hidden: true })
              .find((button) => !button.closest("aside"))
        if (!createPr) throw new Error("The conversation has no Create PR")
        if (wide) {
          expect(createPr).toBeVisible()
          expect(createPr.closest("aside")).toBeNull()
        }
        const actions = createPr.parentElement
        if (!actions) throw new Error("The publish actions are missing")
        return actions
      },
      { timeout: 15_000 },
    )
    const pane = document.querySelector("aside")
    if (!pane) throw new Error("The tools pane is missing")
    const headerNames = publishActionNames(header, !wide)
    if (wide)
      await userEvent.click(page.getByRole("button", { name: "Maximize pane" }))
    await waitFor(() => {
      expect(publishActionNames(pane)).toEqual(headerNames)
      expect(
        within(pane).getByRole("button", { name: "Create PR" }),
      ).toBeVisible()
      expect(
        within(pane).getByRole("button", { name: "Repo layout" }),
      ).toBeVisible()
    })
  },
})

const idleBudget = { conversation: 0, tree: 0, status: 0, chat: 0, diff: 0 }

/**
 * Workspace page in the org shell, with a conversation and the Files pane open:
 * the page is idle, and its request count stays fixed.
 */
export const StableRequestBudget = meta.story({
  tags: ["required"],
  args: { conversationId: "conv_1", paneParam: "files" },
  decorators: [
    (Story) => (
      <div className="min-h-svh w-[1280px] max-w-none">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
  },
  parameters: {
    intent:
      "Catches an idle workspace page that keeps sending requests. Conversation, tree, and status reads must stay at a fixed count. Not for response content.",
    route: "/$orgSlug/ws/$workspaceSlug/$conversationId",
    storyRoute: workspaceRoute({ conversationId: "conv_1", pane: "files" }),
  },
  play: async ({ canvasElement }) => {
    idleBudget.conversation = 0
    idleBudget.tree = 0
    idleBudget.status = 0
    idleBudget.chat = 0
    idleBudget.diff = 0
    const page = within(canvasElement.ownerDocument.body)
    // Below `lg` the open pane hides the conversation, so its composer is
    // in the document but not visible.
    await waitFor(() => {
      const composer = page.getByPlaceholderText(/continue the conversation/i)
      if (minWidth(canvasElement, "64rem")) expect(composer).toBeVisible()
    })
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
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * Files pane is open next to the new conversation composer.
 */
export const FilesPane = meta.story({
  args: { paneParam: "files" },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers())
  },
  parameters: {
    storyRoute: workspaceRoute({ pane: "files" }),
  },
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * Graph pane is open and shows the knowledge graph.
 */
export const GraphPane = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers())
  },
  // With reduced motion the layout runs a fixed number of steps before the
  // graph shows. The play waits for it: without the wait, the screenshot
  // showed a loading stage of the graph that depended on the host speed.
  tags: ["reduced-motion"],
  args: { paneParam: "graph" },
  parameters: {
    storyRoute: workspaceRoute({ pane: "graph" }),
  },
  play: async ({ canvasElement }) => {
    const body = canvasElement.ownerDocument.body
    // With reduced motion, the graph shows when its layout has stopped.
    // Then the control to play the layout again shows.
    await waitForGraphReady(body)
    within(body).getByRole("button", { name: "Play layout" })
  },
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * Settings pane is open.
 */
export const SettingsPane = meta.story({
  args: { paneParam: "settings" },
  beforeEach: ({ msw }) => {
    msw.use(
      ...workspaceShellHandlers({
        workspaces: [docsWorkspace, readOnlyWorkspace],
      }),
    )
  },
  parameters: {
    storyRoute: workspaceRoute({ pane: "settings" }),
  },
})

/**
 * Workspace page in the org shell, with the Settings pane open. A link from
 * Home lands on the upgrades in the Status group. Only the scroll area of the
 * pane moves, so no outer box scrolls and the pane keeps filling the panel.
 */
export const SettingsPaneLandsOnUpgrades = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
      ...workspaceShellHandlers(),
    )
  },
  parameters: {
    storyRoute: workspaceRoute({ pane: "settings", hash: "upgrades" }),
  },
  play: async ({ canvasElement }) => {
    const group = await waitFor(() => {
      const found = canvasElement.querySelector<HTMLElement>(
        "#workspace-settings-upgrades",
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
})

/**
 * Workspace page in the org shell, with the Settings pane open. The user clicks
 * Fix using agent for a skipped file. The composer of a new conversation fills
 * with a fix request, and the Settings pane stays open.
 */
export const FixUsingAgentOpensChat = meta.story({
  parameters: {
    storyRoute: workspaceRoute({ pane: "settings" }),
  },
  beforeEach: ({ msw }) => {
    msw.use(...workspaceShellHandlers({ detail: skippedFilesWorkspaceDetail }))
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
})

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

/**
 * Workspace page in the org shell, with the Settings pane open: the GitHub
 * write access check failed, so polling stops and a Check again alert shows.
 */
export const WriteCheckFailedStopsPolling = meta.story({
  tags: ["required"],
  args: { paneParam: "settings" },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          /\/api\/v1\/workspaces\/[^/]+$/.test(new URL(request.url).pathname),
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
    )
    writeCheck.phase = "failed"
    writeCheck.detailReads = 0
    writeCheck.readsWhileChecking = 0
  },
  parameters: {
    visual: {
      // At the mobile width the screenshot is the same as SettingsPane.
      viewports: ["desktop"],
    },
    intent:
      "Catches a failed write access check that polls the workspace forever. Polling stops and the failure reason shows. Not for a stalled check.",
    storyRoute: workspaceRoute({ pane: "settings" }),
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
        expect(
          canvas.getAllByText("ctxpipe can push to this repository.").length,
        ).toBeGreaterThan(0),
      { timeout: 10_000 },
    )
    await expect(canvas.queryByText("Could not check write access")).toBeNull()
    await expectNoDetailPoll()
  },
})

/**
 * Workspace page in the org shell, with the Settings pane open: the GitHub
 * write access check stalls, so polling stops at the cap with a Check again
 * button.
 */
export const WriteCheckStallStopsPolling = meta.story({
  tags: ["required"],
  // A short cap, so the story does not wait three minutes.
  args: { paneParam: "settings", writeCheckPollCapMs: 3000 },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) =>
          /\/api\/v1\/workspaces\/[^/]+$/.test(new URL(request.url).pathname),
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
    )
    writeCheck.phase = "stuck"
    writeCheck.detailReads = 0
  },
  parameters: {
    intent:
      "Catches a write access check that never ends and polls forever. Polling stops at the cap and the page stops showing a check in progress. Not for failed checks.",
    storyRoute: workspaceRoute({ pane: "settings" }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // A stalled check is a wait: a status row, not a warning.
    const row = await waitFor(
      () => {
        const found = canvas
          .getAllByRole("status")
          .find((el) => el.textContent?.includes("Still checking write access"))
        if (!found) throw new Error("The stalled check row is missing")
        return found
      },
      { timeout: 10_000 },
    )
    await expectNoDetailPoll()

    // Check again resets the timer, so polling starts again.
    const reads = writeCheck.detailReads
    await userEvent.click(
      within(row).getByRole("button", { name: "Check again" }),
    )
    await waitFor(() => expect(writeCheck.detailReads).toBeGreaterThan(reads), {
      timeout: 10_000,
    })
    await waitFor(
      () =>
        expect(
          canvas
            .getAllByRole("status")
            .some((el) =>
              el.textContent?.includes("Still checking write access"),
            ),
        ).toBe(true),
      { timeout: 10_000 },
    )
  },
})

/**
 * Workspace page in the org shell, where a member chats with the agent: the
 * GitHub App cannot write to the repository, so the Workspace is read-only.
 */
export const ReadOnly = meta.story({
  args: { workspaceSlug: "handbook" },
  beforeEach: ({ msw }) => {
    msw.use(
      ...workspaceShellHandlers({
        workspaces: [docsWorkspace, readOnlyWorkspace],
        detail: { ...readOnlyWorkspace, linkedRepositories: [] },
      }),
    )
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "handbook",
    } satisfies StoryRouteParams,
  },
})

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

/**
 * Test stage of the Workspace delete flow from Settings. The user deleted the
 * open Workspace, and the stage goes Home with a toast and no error page.
 */
export const DeleteWorkspaceShowsNoError = meta.story({
  tags: ["required", "!page"],
  args: { paneParam: "settings" },
  render: (args) => <DeleteFlowStage {...args} />,
  decorators: deleteFlowDecorators,
  beforeEach: ({ msw }) => {
    msw.use(...deleteFlowHandlers([readOnlyWorkspace]))
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a test stage, which the product does not render.",
    },
    intent:
      "Catches a workspace delete that flashes an error screen. After delete, the page leaves the deleted workspace with no error. Not for the last workspace or conversation URLs.",
    storyRoute: {
      pattern: "flat",
      path: `/${orgSlug}/ws/${workspaceSlug}`,
      alsoAt: [`/${orgSlug}`],
    } satisfies StoryRouteParams,
    review: {
      kind: "component",
    },
  },
  play: ({ canvasElement }) => deleteOpenWorkspace(canvasElement),
})

/**
 * Test stage of the Workspace delete flow from Settings. The user deleted the
 * last Workspace of the org, and the stage goes Home with no error page.
 */
export const DeleteLastWorkspaceShowsNoError = meta.story({
  ...DeleteWorkspaceShowsNoError.input,
  tags: ["required", "!page"],
  play: ({ canvasElement }) => deleteOpenWorkspace(canvasElement),
  beforeEach: ({ msw }) => {
    msw.use(...deleteFlowHandlers([]))
  },
  parameters: {
    ...DeleteWorkspaceShowsNoError.input.parameters,
    visual: {
      skip: "Behavior test: it ends on a test stage, which the product does not render.",
    },
    intent:
      "Catches a delete of the last workspace that flashes an error screen. The page leaves with no error. Not for other workspaces.",
    review: {
      kind: "component",
    },
  },
})

/**
 * Test stage of the Workspace delete flow from Settings. The user deleted the
 * Workspace from a conversation URL, and the stage goes Home with no error
 * page.
 */
export const DeleteFromConversationShowsNoError = meta.story({
  ...DeleteWorkspaceShowsNoError.input,
  tags: ["required", "!page"],
  play: ({ canvasElement }) => deleteOpenWorkspace(canvasElement),
  args: { paneParam: "settings", conversationId: "conv_1" },
  parameters: {
    ...DeleteWorkspaceShowsNoError.input.parameters,
    visual: {
      skip: "Behavior test: it ends on a test stage, which the product does not render.",
    },
    intent:
      "Catches a workspace delete from a conversation URL that flashes an error screen. The page leaves with no error. Not for workspace-level URLs.",
    storyRoute: {
      pattern: "flat",
      path: `/${orgSlug}/ws/${workspaceSlug}/conv_1`,
      alsoAt: [`/${orgSlug}`],
    } satisfies StoryRouteParams,
    review: {
      kind: "component",
    },
  },
})

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
 * Workspace page in the org shell, made for a demo video of CTX-959. The
 * sidebar shows the ingesting dot, and Workspace settings shows the progress
 * move. The work list empties when the work ends, after about 30 seconds. The
 * state changes with time, on each read.
 */
export const IngestingDemo = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("owner"),
      ...workspaceIngestionHandlers(() =>
        ingestionDemoState((Date.now() - demoStart) / 1000),
      ),
      workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
      workspaceSourcesHandler(workspaceSourceList()),
      orgConnectionsHandler([{ id: "con_gh", type: "github" }]),
      githubInstallationReposHandler(),
      ...workspaceShellHandlers(),
    )
    demoStart = Date.now()
  },
  parameters: {
    visual: {
      // At the mobile width the screenshot is the same as Compose.
      viewports: ["desktop"],
    },
    storyRoute: workspaceRoute(),
  },
})
