import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"
import {
  docsWorkspace,
  pendingWriteWorkspace,
  readOnlyWorkspace,
} from "./workspace-fixtures"

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
          Ask about this Workspace.
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

/** Uncommitted changes: Sync (cloud-upload icon) and Create PR. */
export const DirtyCommitPush: Story = {
  args: {
    title: "Repo layout",
    branch: {
      shortName: "chat/1",
      fullRef: "ctxpipe/chat/conv_1/1",
    },
    publish: {
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
    expect(canvas.getByRole("button", { name: "Create PR" })).toBeVisible()
  },
}

/** A stale branch or a running turn: Sync shows but is disabled. */
export const SyncDisabled: Story = {
  args: {
    ...DirtyCommitPush.args,
    publish: {
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
    expect(await canvas.findByRole("button", { name: syncName })).toBeDisabled()
  },
}

export const CommittedCreatePrOnly: Story = {
  args: {
    title: "Repo layout",
    branch: {
      shortName: "chat/1",
      fullRef: "ctxpipe/chat/conv_1/1",
    },
    publish: {
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
    expect(
      canvas.queryByRole("button", { name: syncName }),
    ).not.toBeInTheDocument()
    expect(canvas.getByRole("button", { name: "Create PR" })).toBeVisible()
  },
}

export const CleanNoPublishActions: Story = {
  args: {
    title: "Repo layout",
    branch: {
      shortName: "chat/1",
      fullRef: "ctxpipe/chat/conv_1/1",
    },
    publish: {
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
  args: {
    ...DirtyCommitPush.args,
    publish: {
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
  },
}

export const CreatingPr: Story = {
  args: {
    ...DirtyCommitPush.args,
    publish: {
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

export const ShowPr: Story = {
  args: {
    title: "Repo layout",
    branch: {
      shortName: "chat/1",
      fullRef: "ctxpipe/chat/conv_1/1",
      href: "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
    },
    publish: {
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
    expect(
      canvas.queryByRole("button", { name: syncName }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
    expect(canvas.getByRole("link", { name: "Show PR" })).toBeVisible()
  },
}

/** A PR is open and the agent made commits it did not push: Sync and Show PR. */
export const CommitPushWithOpenPr: Story = {
  args: {
    title: "Repo layout",
    branch: {
      shortName: "chat/1",
      fullRef: "ctxpipe/chat/conv_1/1",
      href: "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
    },
    publish: {
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
    expect(canvas.getByRole("link", { name: "Show PR" })).toHaveAttribute(
      "href",
      "https://github.com/acme/docs/pull/41",
    )
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
    await userEvent.click(commitPush)
    expect(args.publish?.commitPush.onPress).toHaveBeenCalledOnce()
  },
}

export const MergedCreatePrAgain: Story = {
  args: {
    ...DirtyCommitPush.args,
    branch: {
      shortName: "chat/1",
      fullRef: "ctxpipe/chat/conv_1/1",
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
