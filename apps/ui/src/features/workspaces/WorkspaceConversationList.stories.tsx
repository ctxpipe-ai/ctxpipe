import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  conversationsListHandler,
  conversationsListLoadingHandler,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceConversationList } from "./WorkspaceConversationList"
import { docsConversations, docsWorkspace } from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/ConversationList",
  component: WorkspaceConversationList,
  decorators: [
    (Story) => (
      <div className="w-64 bg-zinc-950 py-2">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspace,
    navExpanded: true,
    currentConversationId: "conv_1",
  },
} satisfies Meta<typeof WorkspaceConversationList>

export default meta

type Story = StoryObj<typeof meta>

export const WithConversations: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [conversationsListHandler(docsConversations)],
      },
    },
  },
}

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [conversationsListHandler([])],
      },
    },
  },
}

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [conversationsListLoadingHandler()],
      },
    },
  },
}

export const LoadMore: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          conversationsListHandler(docsConversations, {
            hasNextPage: true,
            hasPreviousPage: false,
            startCursor: "conv_1",
            endCursor: "conv_2",
          }),
        ],
      },
    },
  },
}

export const Collapsed: Story = {
  args: {
    navExpanded: false,
  },
  parameters: {
    msw: {
      handlers: {
        page: [conversationsListHandler(docsConversations)],
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="w-16 bg-zinc-950 py-2">
        <Story />
      </div>
    ),
  ],
}
