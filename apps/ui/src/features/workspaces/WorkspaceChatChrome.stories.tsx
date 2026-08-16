import type { Meta, StoryObj } from "@storybook/react-vite"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"
import { docsWorkspace, readOnlyWorkspace } from "./workspace-fixtures"

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
