import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  conversationDetailHandler,
  conversationDetailLoadingHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceChat } from "./WorkspaceChat"
import { docsWorkspace } from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/Chat",
  component: WorkspaceChat,
  decorators: [
    (Story) => (
      <div className="flex h-[32rem] bg-zinc-950">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspace,
  },
} satisfies Meta<typeof WorkspaceChat>

export default meta

type Story = StoryObj<typeof meta>

export const ComposeEmpty: Story = {
  parameters: {
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
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [conversationDetailLoadingHandler(), ...workspaceShellHandlers()],
      },
    },
  },
}

export const ConversationMissing: Story = {
  args: { conversationId: "conv_missing" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_missing",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [conversationDetailHandler(null), ...workspaceShellHandlers()],
      },
    },
  },
}

export const ConversationReady: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}
