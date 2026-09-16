import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { ConversationList } from "./ConversationList"

const orgSlug = "acme"

const meta = {
  title: "Components/Chat/ConversationList",
  component: ConversationList,
  decorators: [
    (Story) => (
      <div className="h-[28rem] w-64 border-r border-white/[0.04] bg-zinc-950">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug,
    currentConversationId: "conv_ui_1",
  },
} satisfies Meta<typeof ConversationList>

export default meta

type Story = StoryObj<typeof meta>

function conversationItem(input: {
  id: string
  name: string
  source: string
  userId: string | null
}) {
  return {
    id: input.id,
    orgId: "org_storybook",
    userId: input.userId,
    name: input.name,
    source: input.source,
    lastMessageAt: "2026-09-14T10:00:00.000Z",
    createdAt: "2026-09-14T09:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
  }
}

function conversationsHandler(items: ReturnType<typeof conversationItem>[]) {
  return http.get(`*/${orgSlug}/api/v1/conversations`, ({ request }) => {
    const source = new URL(request.url).searchParams.get("source")
    const filtered =
      source === "mcp-service"
        ? items.filter((item) => item.source === "mcp" && item.userId === null)
        : items.filter(
            (item) =>
              item.source === source && item.userId === "user_storybook",
          )
    return HttpResponse.json({
      items: filtered,
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      },
    })
  })
}

function memberRoleHandler(role: "admin" | "owner" | "member") {
  return http.get(
    "*/.auth/api/v1/auth/organization/get-active-member-role",
    () => HttpResponse.json({ role }),
  )
}

const listItems = [
  conversationItem({
    id: "conv_ui_1",
    name: "Ask about auth",
    source: "ui",
    userId: "user_storybook",
  }),
  conversationItem({
    id: "conv_mcp_1",
    name: "MCP advisor thread",
    source: "mcp",
    userId: "user_storybook",
  }),
  conversationItem({
    id: "conv_org_1",
    name: "Org MCP service",
    source: "mcp",
    userId: null,
  }),
]

async function openSourceFilter(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.click(
    canvas.getByRole("button", { name: "Filter by source" }),
  )
  return within(canvasElement.ownerDocument.body)
}

export const AdminUiThreads: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [memberRoleHandler("admin"), conversationsHandler(listItems)],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const menu = await openSourceFilter(canvasElement)
    await expect(
      menu.getByRole("menuitemradio", { name: "UI" }),
    ).toBeInTheDocument()
    await expect(
      menu.getByRole("menuitemradio", { name: "MCP" }),
    ).toBeInTheDocument()
    await expect(
      menu.getByRole("menuitemradio", { name: "MCP service" }),
    ).toBeInTheDocument()
  },
}

export const AdminMcpServiceThreads: Story = {
  args: {
    currentConversationId: "conv_org_1",
  },
  parameters: {
    msw: {
      handlers: {
        page: [memberRoleHandler("admin"), conversationsHandler(listItems)],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const menu = await openSourceFilter(canvasElement)
    await userEvent.click(
      menu.getByRole("menuitemradio", { name: "MCP service" }),
    )
    const canvas = within(canvasElement)
    await expect(canvas.getByText("Org MCP service")).toBeInTheDocument()
  },
}

export const MemberHidesMcpService: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [memberRoleHandler("member"), conversationsHandler(listItems)],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const menu = await openSourceFilter(canvasElement)
    await expect(
      menu.getByRole("menuitemradio", { name: "UI" }),
    ).toBeInTheDocument()
    await expect(
      menu.getByRole("menuitemradio", { name: "MCP" }),
    ).toBeInTheDocument()
    await expect(
      menu.queryByRole("menuitemradio", { name: "MCP service" }),
    ).not.toBeInTheDocument()
  },
}

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [memberRoleHandler("admin"), conversationsHandler([])],
      },
    },
  },
}

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          memberRoleHandler("admin"),
          http.get(`*/${orgSlug}/api/v1/conversations`, async () => {
            await delay("infinite")
            return HttpResponse.json({ items: [] })
          }),
        ],
      },
    },
  },
}
