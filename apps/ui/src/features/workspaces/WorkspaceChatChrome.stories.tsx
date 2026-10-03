import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
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

const sessionBranch = {
  shortName: "chat/1",
  fullRef: "ctxpipe/chat/conv_1/1",
  href: "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
}

const createPrPresses = { count: 0 }

/**
 * Turn commits are already on the conversation branch; the only publish
 * action is Create PR, which squashes them. There is no Commit+Push.
 */
export const CreatePr: Story = {
  args: {
    title: "Repo layout",
    branch: sessionBranch,
    publish: {
      pullRequest: {
        visible: true,
        action: "create",
        pending: false,
        onPress: () => {
          createPrPresses.count += 1
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    createPrPresses.count = 0
    const canvas = within(canvasElement)
    const createPr = await canvas.findByRole("button", { name: "Create PR" })
    expect(
      canvas.queryByRole("button", { name: /commit|push/i }),
    ).not.toBeInTheDocument()
    expect(
      canvas.getByRole("link", { name: sessionBranch.fullRef }),
    ).toBeVisible()
    await userEvent.click(createPr)
    expect(createPrPresses.count).toBe(1)
  },
}

export const CleanNoPublishActions: Story = {
  args: {
    title: "Repo layout",
    branch: { shortName: "chat/1", fullRef: "ctxpipe/chat/conv_1/1" },
    publish: {
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
    expect(await canvas.findByText("Repo layout")).toBeVisible()
    expect(
      canvas.queryByRole("button", { name: /commit|push/i }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
  },
}

export const CreatingPr: Story = {
  args: {
    ...CreatePr.args,
    publish: {
      pullRequest: {
        visible: true,
        action: "create",
        pending: true,
        onPress: () => {},
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const pending = await canvas.findByRole("button", {
      name: /creating pr/i,
    })
    expect(pending).toHaveAttribute("aria-disabled", "true")
  },
}

export const ShowPr: Story = {
  args: {
    title: "Repo layout",
    branch: sessionBranch,
    publish: {
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
      await canvas.findByRole("link", { name: "Show PR" }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/41")
    expect(
      canvas.queryByRole("button", { name: /commit|push/i }),
    ).not.toBeInTheDocument()
    expect(
      canvas.queryByRole("button", { name: "Create PR" }),
    ).not.toBeInTheDocument()
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
