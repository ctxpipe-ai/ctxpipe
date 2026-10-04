import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"
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

export const Writable: Story = {}

export const ReadOnly: Story = {
  args: {
    workspace: readOnlyWorkspace,
    title: "Handbook",
  },
}

export const PendingProbe: Story = {
  args: {
    workspace: pendingWriteWorkspace,
    title: "Repo layout",
  },
}

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
    expect(canvas.getByRole("button", { name: "Commit+Push" })).toBeVisible()
    expect(canvas.getByRole("button", { name: "Create PR" })).toBeVisible()
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
      canvas.queryByRole("button", { name: "Commit+Push" }),
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
      canvas.queryByRole("button", { name: "Commit+Push" }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
  },
}

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
      canvas.queryByRole("button", { name: "Commit+Push" }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
    expect(canvas.getByRole("link", { name: "Show PR" })).toBeVisible()
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
