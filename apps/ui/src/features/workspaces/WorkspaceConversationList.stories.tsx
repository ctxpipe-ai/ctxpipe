import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, waitFor, within } from "storybook/test"
import {
  expectBoxUnchanged,
  responseGate,
} from "@/components/ui/skeletonMatchStory"
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
    onSelectNav: () => {},
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

const conversationsGate = responseGate()
const threeConversations = [0, 1, 2].map((row) => ({
  ...docsConversations[0],
  id: `conv_${row + 1}`,
  name: `Conversation ${row + 1}`,
}))

/** The loading rows have the same box as three loaded conversations. */
export const ConversationListSkeletonMatches: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations$/.test(new URL(request.url).pathname),
            async () => {
              await conversationsGate.wait()
              return HttpResponse.json({
                items: threeConversations,
                pageInfo: { hasNextPage: false, endCursor: null },
              })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const loading = await canvas.findByText("Loading conversations")
    const list = loading.closest("ul")
    if (!list) throw new Error("No conversation list")
    await expectBoxUnchanged(list, async () => {
      await conversationsGate.release()
      await waitFor(() =>
        expect(
          canvas.getByRole("link", { name: "Conversation 3" }),
        ).toBeVisible(),
      )
    })
  },
}
