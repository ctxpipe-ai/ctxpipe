import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { InlineAlert } from "@/components/ui/InlineAlert"
import { ConversationThread } from "@/features/chat/ConversationThread"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import {
  docsConversationDetail,
  docsWorkspace,
  pendingWriteWorkspace,
  readOnlyWorkspace,
} from "./workspace-fixtures"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"

const meta = preview.meta({
  title: "Components/Workspaces/ChatChrome",
  component: WorkspaceChatChrome,
  decorators: [
    (Story) => (
      <div className="flex h-[28rem] bg-zinc-950">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
  args: {
    workspace: docsWorkspace,
    title: "Billing structure",
    // The header sits above the thread of the conversation, as in the chat.
    children: (
      <ConversationThread
        messages={docsConversationDetail.messages}
        error={null}
        status="ready"
      />
    ),
  },
})

const syncName = "Sync: commit and push your changes"

/**
 * Chat header of a Workspace conversation above its thread: the Workspace is
 * writable and the conversation changed no files yet, so no access badge, no
 * branch and no publish button show.
 */
export const Writable = meta.story()

/**
 * Chat header of a Workspace conversation above its thread: the GitHub App
 * cannot write to the repository, so a Read-only badge shows.
 */
export const ReadOnly = meta.story({
  args: {
    workspace: readOnlyWorkspace,
    title: "Billing structure",
  },
  play: async ({ canvasElement }) => {
    const pill = await within(canvasElement).findByText("Read-only")
    // Assistive tech gets the reason without the hover popup.
    await expect(pill).toHaveTextContent(
      "The GitHub App cannot write to this repository.",
    )
  },
})

/**
 * Chat header of a Workspace conversation, with its title and access badge. The
 * default branch is protected, so the conversation opens a pull request, and
 * the badge is neutral.
 */
export const ProtectedDefaultBranch = meta.story({
  args: {
    workspace: {
      ...readOnlyWorkspace,
      conversationWritable: true,
      readOnlyReason:
        "The default branch is protected. Jobs cannot push it; conversation chat can still push a session branch and open a pull request.",
    },
    title: "Billing structure",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const pill = await canvas.findByText("Changes by pull request")
    await expect(pill).toHaveTextContent(
      "A conversation pushes its own branch and opens a pull request.",
    )
    await expect(pill).toHaveClass("text-muted-foreground")
    await expect(canvas.queryByText("Read-only")).not.toBeInTheDocument()
  },
})

/**
 * Chat header of a Workspace conversation, with its title and access badge:
 * ctxpipe still checks if the GitHub App can push, and a tooltip says so.
 */
export const PendingProbe = meta.story({
  args: {
    workspace: pendingWriteWorkspace,
    title: "Billing structure",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const pill = await canvas.findByText("Checking write access")
    // A span, not a focusable no-op button, with the text for assistive tech.
    await expect(pill.tagName).toBe("SPAN")
    await expect(pill).not.toHaveAttribute("tabindex")
    await expect(pill).toHaveTextContent(
      "Checking whether the GitHub App can push to this repository",
    )
    await userEvent.hover(pill)
    const tooltip = await within(canvasElement.ownerDocument.body).findByText(
      "Checking whether the GitHub App can push to this repository",
    )
    await waitFor(() => expect(tooltip).toBeVisible())
  },
})

/**
 * Chat header of a Workspace conversation, with its publish buttons. The branch
 * has uncommitted changes, so only the Sync button (cloud-upload icon) shows,
 * with its tooltip. Create PR waits until the branch is synced.
 */
export const DirtyCommitPush = meta.story({
  args: {
    title: "Billing structure",
    branch: {
      shortName: "chat/1",
    },
    cta: {
      commitPush: {
        visible: true,
        enabled: true,
        pending: false,
        onPress: () => {},
      },
      pullRequest: {
        visible: true,
        action: "create",
        pending: false,
        onPress: () => {},
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const sync = await canvas.findByRole("button", { name: syncName })
    expect(sync).toBeVisible()
    expect(sync).toHaveTextContent("Sync")
    await userEvent.hover(sync)
    const tooltip = await within(canvasElement.ownerDocument.body).findByText(
      "Commit and push your changes to the conversation branch",
    )
    // The tooltip fades in, so wait for it to become visible.
    await waitFor(() => expect(tooltip).toBeVisible())
    expect(canvas.queryByRole("button", { name: "Create PR" })).toBeNull()
  },
})

/**
 * Chat header of a Workspace conversation, with its publish buttons. The branch
 * is stale or a turn runs, so the Sync button shows but is disabled.
 */
export const SyncDisabled = meta.story({
  args: {
    ...DirtyCommitPush.input.args,
    cta: {
      commitPush: {
        visible: true,
        enabled: false,
        pending: false,
        onPress: () => {},
      },
      pullRequest: {
        visible: true,
        action: "create",
        pending: false,
        onPress: () => {},
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: syncName })).toBeDisabled(),
    )
  },
})

/**
 * Chat header of a Workspace conversation, with its publish buttons: all
 * changes are pushed and no pull request exists, so only Create PR shows.
 */
export const CommittedCreatePrOnly = meta.story({
  args: {
    title: "Billing structure",
    branch: {
      shortName: "chat/1",
    },
    cta: {
      commitPush: {
        visible: false,
        enabled: false,
        pending: false,
        onPress: () => {},
      },
      pullRequest: {
        visible: true,
        action: "create",
        pending: false,
        onPress: () => {},
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Create PR" })).toBeVisible(),
    )
    expect(
      canvas.queryByRole("button", { name: syncName }),
    ).not.toBeInTheDocument()
  },
})

/**
 * Chat header of a conversation that the member started from the branch
 * release/2026-11: after the title, plain muted text names that base, an
 * arrow and the session branch chat/1. It is not a control, because the base
 * is fixed after the first message. Create PR opens the pull request into it.
 */
export const BaseBranchLabel = meta.story({
  args: {
    title: "Release notes",
    branch: {
      shortName: "chat/1",
      base: "release/2026-11",
    },
    cta: {
      commitPush: {
        visible: false,
        enabled: false,
        pending: false,
        onPress: () => {},
      },
      pullRequest: {
        visible: true,
        action: "create",
        pending: false,
        onPress: () => {},
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("release/2026-11")).toBeVisible(),
    )
    expect(canvas.getByText("chat/1")).toBeVisible()
  },
})

/**
 * Chat header of a Workspace conversation, with its publish buttons: the branch
 * has no changes, so no Sync or pull request button shows.
 */
export const CleanNoPublishActions = meta.story({
  args: {
    title: "Billing structure",
    branch: {
      shortName: "chat/1",
    },
    cta: {
      commitPush: {
        visible: false,
        enabled: false,
        pending: false,
        onPress: () => {},
      },
      pullRequest: {
        visible: false,
        action: "create",
        pending: false,
        onPress: () => {},
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Billing structure")
    expect(
      canvas.queryByRole("button", { name: syncName }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
  },
})

/**
 * Chat header of a Workspace conversation, with its publish buttons. The sync
 * push runs, so the Sync button is busy and disabled, at full opacity.
 */
export const Pushing = meta.story({
  parameters: {
    intent:
      "Catches a pending commit and push button that looks dimmed or stays pressable. It is disabled and marked pending, but keeps full opacity. Not for the idle button or PR actions.",
  },
  tags: ["required"],
  args: {
    ...DirtyCommitPush.input.args,
    cta: {
      commitPush: {
        visible: true,
        enabled: true,
        pending: true,
        onPress: () => {},
      },
      pullRequest: {
        visible: true,
        action: "create",
        pending: false,
        onPress: () => {},
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const sync = await canvas.findByRole("button", {
      name: "Syncing: commit and push in progress",
    })
    expect(sync).toBeDisabled()
    expect(sync).toHaveAttribute("data-pending", "true")
    // Pending is not the dimmed disabled look.
    expect(getComputedStyle(sync).opacity).toBe("1")
  },
})

/**
 * Chat header of a Workspace conversation, with its publish buttons: the
 * request to create the pull request runs and is pending.
 */
export const CreatingPr = meta.story({
  args: {
    ...DirtyCommitPush.input.args,
    cta: {
      commitPush: {
        visible: true,
        enabled: true,
        pending: false,
        onPress: () => {},
      },
      pullRequest: {
        visible: true,
        action: "create",
        pending: true,
        onPress: () => {},
      },
    },
  },
})

/**
 * Chat header of a Workspace conversation, above its thread. A pull request is
 * open and the branch has no new changes, so Show PR and the branch show. Show
 * PR has the pull request icon on the left and no external-link icon. Its name
 * tells that it opens in a new tab.
 */
export const ShowPr = meta.story({
  parameters: {
    intent:
      "Catches a chat header that hides the pull request link when a PR exists. It shows a Show PR link that opens in a new tab. Not for creating a PR or the sync button.",
  },
  tags: ["required"],
  args: {
    title: "Billing structure",
    branch: {
      shortName: "chat/1",
      href: "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
    },
    cta: {
      commitPush: {
        visible: false,
        enabled: false,
        pending: false,
        onPress: () => {},
      },
      pullRequest: {
        visible: true,
        action: "show",
        pending: false,
        href: "https://github.com/acme/docs/pull/41",
        onPress: () => {},
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const showPr = await canvas.findByRole(
      "link",
      { name: "Show PR (opens in a new tab)" },
      { timeout: 15_000 },
    )
    expect(
      canvas.queryByRole("button", { name: syncName }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
    expect(showPr).toBeVisible()
    expect(showPr).toHaveAttribute("target", "_blank")
    expect(
      showPr.querySelector("svg.tabler-icon-git-pull-request"),
    ).not.toBeNull()
    expect(showPr.querySelector("svg.tabler-icon-external-link")).toBeNull()
    // The icon is the first child, left of the text.
    expect(showPr.firstElementChild).toBe(
      showPr.querySelector("svg.tabler-icon-git-pull-request"),
    )
  },
})

/**
 * Chat header of a Workspace conversation, with its publish buttons. A pull
 * request is open and the agent made commits that it did not push, so Sync and
 * Show PR show.
 */
export const CommitPushWithOpenPr = meta.story({
  args: {
    title: "Billing structure",
    branch: {
      shortName: "chat/1",
      href: "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
    },
    cta: {
      commitPush: {
        visible: true,
        enabled: true,
        pending: false,
        onPress: fn(),
      },
      pullRequest: {
        visible: true,
        action: "show",
        pending: false,
        href: "https://github.com/acme/docs/pull/41",
        onPress: () => {},
      },
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const commitPush = await canvas.findByRole("button", {
      name: syncName,
    })
    expect(
      canvas.getByRole("link", { name: "Show PR (opens in a new tab)" }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/41")
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
    await userEvent.click(commitPush)
    expect(args.cta?.commitPush.onPress).toHaveBeenCalledOnce()
  },
})

/**
 * Chat header of a Workspace conversation, with its publish buttons: the old
 * pull request merged and the branch has new changes, with a branch link.
 */
export const MergedCreatePrAgain = meta.story({
  args: {
    ...DirtyCommitPush.input.args,
    branch: {
      shortName: "chat/1",
      href: "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
    },
  },
})

/**
 * Chat header and body of a Workspace conversation: the chat sandbox is gone,
 * and an error alert in the body tells the user to send another message.
 */
export const ChatError = meta.story({
  args: {
    title: "Billing structure",
    children: (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-sm">
          <InlineAlert variant="error">
            The chat sandbox is gone. Send another message to start a fresh
            tree.
          </InlineAlert>
        </div>
      </div>
    ),
  },
})

const syncCta = {
  commitPush: {
    visible: true,
    enabled: true,
    pending: false,
    onPress: () => {},
  },
  pullRequest: {
    visible: true,
    action: "create" as const,
    pending: false,
    onPress: () => {},
  },
}

/**
 * Chat header of a Workspace conversation, with its publish buttons. The
 * pointer rests on Sync, so the button has its hover face from the tokens, and
 * a tooltip tells what Sync does. The CTA button has a light face with dark
 * text.
 */
export const CtaButtonStyle = meta.story({
  parameters: {
    intent:
      "Catches a sync button with the wrong look. It needs a filled face, small text, a low height, no external-link icon, and a hover change. Not for button actions.",
  },
  tags: ["required"],
  args: { cta: syncCta },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const sync = await canvas.findByRole("button", { name: syncName })
    const face = getComputedStyle(sync)
    expect(face.backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
    expect(face.color).not.toBe(face.backgroundColor)
    expect(face.fontSize).toBe("12px")
    expect(face.fontWeight).toBe("400")
    await document.fonts.ready
    expect(sync.getBoundingClientRect().height).toBeLessThanOrEqual(28)
    expect(sync.querySelector("svg.tabler-icon-external-link")).toBeNull()
    const rest = face.backgroundColor
    await userEvent.hover(sync)
    await waitFor(() =>
      expect(getComputedStyle(sync).backgroundColor).not.toBe(rest),
    )
  },
})

/**
 * Chat header of a Workspace conversation, with its branch label. The branch
 * name is very long and truncates next to its git-branch icon. No tooltip shows
 * the internal ref.
 */
export const BranchLabel = meta.story({
  parameters: {
    intent:
      "Catches a branch label that wraps a long name, drops its icon, or shows a tooltip with the internal ref. The name truncates. Not for the branch link.",
  },
  tags: ["required"],
  args: {
    title: "Billing structure",
    branch: {
      shortName: "chat/a-very-long-branch-name-that-does-not-fit-in-the-label",
    },
  },
  play: async ({ canvasElement }) => {
    const name = await within(canvasElement).findByText(/a-very-long/)
    const label = name.closest("[data-branch-label]")
    if (!label) throw new Error("Branch label missing")
    expect(label.firstElementChild).toBe(
      label.querySelector("svg.tabler-icon-git-branch"),
    )
    const text = label.querySelector("span.truncate")
    if (!(text instanceof HTMLElement)) throw new Error("Branch text missing")
    await document.fonts.ready
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth)
    await userEvent.hover(label)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(
      // play-timing: ok the 400 ms sleep after hover outwaits the tooltip delay
      within(canvasElement.ownerDocument.body).queryByRole("tooltip"),
    ).toBeNull()
    expect(
      // play-timing: ok the 400 ms sleep after hover outwaits the tooltip delay
      within(canvasElement.ownerDocument.body).queryByText(
        /ctxpipe\/chat\/conv_1/,
      ),
    ).toBeNull()
  },
})

const prCta = {
  visible: true,
  action: "show" as const,
  pending: false,
  href: "https://github.com/acme/docs/pull/41",
  onPress: () => {},
}

/**
 * Chat header of a Workspace conversation, with its publish buttons. A pull
 * request exists and the branch is dirty, so Sync is the main (CTA) button and
 * Show PR is subtle.
 */
export const SyncCtaWithSubtleShowPr = meta.story({
  parameters: {
    intent:
      "Catches a header with Sync and a PR where Show PR looks the same as Sync or a Create PR button shows. Show PR must look subtler. Not for the sync action.",
  },
  tags: ["required"],
  args: { cta: { ...syncCta, pullRequest: prCta } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const sync = await canvas.findByRole("button", { name: syncName })
    const show = await canvas.findByRole("link", {
      name: "Show PR (opens in a new tab)",
    })
    expect(getComputedStyle(show).backgroundColor).not.toBe(
      getComputedStyle(sync).backgroundColor,
    )
    expect(canvas.queryByRole("button", { name: /Create PR/ })).toBeNull()
  },
})

/**
 * Chat header of a Workspace conversation, with its publish buttons. The
 * conversation has changes that are not synced and no pull request, so only
 * Sync shows. Create PR comes after the sync.
 */
export const DirtyShowsOnlySync = meta.story({
  parameters: {
    intent:
      "Catches a dirty branch with no PR that shows Create PR. It must show only Sync. Not for clean branches or existing PRs.",
  },
  tags: ["required"],
  args: {
    cta: {
      ...syncCta,
      pullRequest: { ...prCta, visible: true, action: "create" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: syncName })
    expect(canvas.queryByRole("button", { name: "Create PR" })).toBeNull()
  },
})
