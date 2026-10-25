import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { InlineAlert } from "@/components/ui/InlineAlert"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  docsWorkspace,
  pendingWriteWorkspace,
  readOnlyWorkspace,
} from "./workspace-fixtures"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"

const meta = {
  title: "Components/Workspaces/ChatChrome",
  component: WorkspaceChatChrome,
  decorators: [
    (Story) => (
      <div className="flex h-[28rem] bg-zinc-950">
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
  },
  args: {
    workspace: docsWorkspace,
    title: "Repo layout",
    children: (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-sm text-muted-foreground">
          What should ctxpipe do in this Workspace?
        </p>
      </div>
    ),
  },
} satisfies Meta<typeof WorkspaceChatChrome>

export default meta

type Story = StoryObj<typeof meta>

const syncName = "Sync: commit and push your changes"

export const Writable: Story = {}

export const ReadOnly: Story = {
  args: {
    workspace: readOnlyWorkspace,
    title: "Handbook",
  },
  play: async ({ canvasElement }) => {
    const pill = await within(canvasElement).findByText("Read-only")
    // Assistive tech gets the reason without the hover popup.
    await expect(pill).toHaveTextContent(
      "The GitHub App cannot write to this repository.",
    )
  },
}

/** A protected default branch: a conversation opens a pull request, so the badge is neutral. */
export const ProtectedDefaultBranch: Story = {
  args: {
    workspace: {
      ...readOnlyWorkspace,
      conversationWritable: true,
      readOnlyReason:
        "The default branch is protected. Jobs cannot push it; conversation chat can still push a session branch and open a pull request.",
    },
    title: "Handbook",
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
}

export const PendingProbe: Story = {
  args: {
    workspace: pendingWriteWorkspace,
    title: "Repo layout",
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
}

/** Uncommitted changes: Sync (cloud-upload icon) only. Create PR waits until the branch is synced. */
export const DirtyCommitPush: Story = {
  args: {
    title: "Repo layout",
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
}

/** A stale branch or a running turn: Sync shows but is disabled. */
export const SyncDisabled: Story = {
  args: {
    ...DirtyCommitPush.args,
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
}

export const CommittedCreatePrOnly: Story = {
  args: {
    title: "Repo layout",
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
}

export const CleanNoPublishActions: Story = {
  args: {
    title: "Repo layout",
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
    await canvas.findByText("Repo layout")
    expect(
      canvas.queryByRole("button", { name: syncName }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
  },
}

/** Sync runs: the button is busy and disabled. */
export const Pushing: Story = {
  tags: ["workspace-golden"],
  args: {
    ...DirtyCommitPush.args,
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
}

export const CreatingPr: Story = {
  args: {
    ...DirtyCommitPush.args,
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
}

/**
 * Show PR has the pull request icon on the left and no external-link icon.
 * Its name tells that it opens in a new tab.
 */
export const ShowPr: Story = {
  tags: ["workspace-golden"],
  args: {
    title: "Repo layout",
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
}

/** A PR is open and the agent made commits it did not push: Sync and Show PR. */
export const CommitPushWithOpenPr: Story = {
  args: {
    title: "Repo layout",
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
}

export const MergedCreatePrAgain: Story = {
  args: {
    ...DirtyCommitPush.args,
    branch: {
      shortName: "chat/1",
      href: "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
    },
  },
}

export const ChatError: Story = {
  args: {
    title: "Repo layout",
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
}

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

/** The CTA button has a light face with dark text, and a hover state from the tokens. */
export const CtaButtonStyle: Story = {
  tags: ["workspace-golden"],
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
}

/** The branch is a label with a git-branch icon. A long name truncates. No tooltip shows the internal ref. */
export const BranchLabel: Story = {
  tags: ["workspace-golden"],
  args: {
    title: "Repo layout",
    branch: {
      shortName: "chat/a-very-long-branch-name-that-does-not-fit-in-the-label",
    },
  },
  play: async ({ canvasElement }) => {
    const name = await within(canvasElement).findByText(/a-very-long/)
    const label = name.parentElement
    if (!label) throw new Error("Branch label missing")
    expect(label.querySelector("svg.tabler-icon-git-branch")).not.toBeNull()
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
}

const prCta = {
  visible: true,
  action: "show" as const,
  pending: false,
  href: "https://github.com/acme/docs/pull/41",
  onPress: () => {},
}

/** A PR exists and the branch is dirty: Sync is the CTA, Show PR is subtle. */
export const SyncCtaWithSubtleShowPr: Story = {
  tags: ["workspace-golden"],
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
}

/** A dirty branch with no PR shows Sync only. */
export const DirtyShowsOnlySync: Story = {
  tags: ["workspace-golden"],
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
}
