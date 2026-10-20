import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
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

const requests: string[] = []

function conversationRequestHandlers(input: {
  del: () => Response | Promise<Response>
}) {
  const conversationPath = (request: Request) =>
    /\/api\/v1\/conversations\/[^/]+$/.test(new URL(request.url).pathname)
  return [
    conversationsListHandler(docsConversations),
    http.patch(
      ({ request }) => conversationPath(request),
      async ({ request }) => {
        const body = (await request.json()) as { name: string }
        requests.push(`PATCH ${new URL(request.url).pathname} ${body.name}`)
        return HttpResponse.json({
          id: "conv_2",
          name: body.name,
          source: "ui",
          lastMessageAt: "2026-08-16T09:12:00.000Z",
        })
      },
    ),
    http.delete(
      ({ request }) => conversationPath(request),
      ({ request }) => {
        requests.push(`DELETE ${new URL(request.url).pathname}`)
        return input.del()
      },
    ),
  ]
}

/** Open the Actions menu of a chat with the keyboard and choose an item. */
async function chooseAction(
  canvasElement: HTMLElement,
  chat: string,
  action: "Rename" | "Delete",
) {
  const canvas = within(canvasElement)
  const link = await canvas.findByRole("link", { name: chat })
  link.focus()
  // The next Tab stop after the chat link is its Actions button.
  await userEvent.tab()
  await waitFor(() =>
    expect(
      canvas.getByRole("button", { name: `Actions for ${chat}` }),
    ).toHaveFocus(),
  )
  await userEvent.keyboard("{Enter}")
  const body = within(canvasElement.ownerDocument.body)
  await userEvent.click(await body.findByRole("menuitem", { name: action }))
}

/** The Actions button shows on keyboard focus and opens a menu with Rename and Delete. */
export const ActionsMenuByKeyboard: Story = {
  beforeEach: () => {
    requests.length = 0
  },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () => new HttpResponse(null, { status: 204 }),
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", { name: "Auth claims" })
    link.focus()
    await userEvent.tab()
    const button = await canvas.findByRole("button", {
      name: "Actions for Auth claims",
    })
    await waitFor(() => expect(button).toHaveFocus())
    await userEvent.keyboard("{Enter}")
    const body = within(canvasElement.ownerDocument.body)
    await body.findByRole("menu", { name: "Actions for Auth claims" })
    await waitFor(() =>
      expect(body.getByRole("menuitem", { name: "Rename" })).toBeVisible(),
    )
    expect(body.getByRole("menuitem", { name: "Delete" })).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(body.queryByRole("menu")).toBeNull())
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Actions for Auth claims" }),
      ).toHaveFocus(),
    )
  },
}

/** Rename edits the name in the row. Enter saves it once, and the new name shows. */
export const RenameFromMenu: Story = {
  beforeEach: () => {
    requests.length = 0
  },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () => new HttpResponse(null, { status: 204 }),
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await chooseAction(canvasElement, "Auth claims", "Rename")
    const input = await canvas.findByRole("textbox", {
      name: "Conversation name",
    })
    await waitFor(() => expect(input).toHaveFocus())
    await userEvent.keyboard("Token claims{Enter}")
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: "Token claims" })).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: "Token claims" })).toHaveFocus(),
    )
    expect(requests).toEqual([
      "PATCH /acme/api/v1/conversations/conv_2 Token claims",
    ])
  },
}

/** Escape cancels a rename. The old name stays and nothing is sent. */
export const RenameCancelWithEscape: Story = {
  beforeEach: () => {
    requests.length = 0
  },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () => new HttpResponse(null, { status: 204 }),
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await chooseAction(canvasElement, "Auth claims", "Rename")
    await canvas.findByRole("textbox", { name: "Conversation name" })
    await userEvent.keyboard("Other{Escape}")
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: "Auth claims" })).toHaveFocus(),
    )
    expect(requests).toEqual([])
  },
}

/** Delete asks first. Cancel keeps the chat and sends nothing. */
export const DeleteCancel: Story = {
  beforeEach: () => {
    requests.length = 0
  },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () => new HttpResponse(null, { status: 204 }),
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await chooseAction(canvasElement, "Auth claims", "Delete")
    await body.findByRole("alertdialog", { name: "Delete this chat?" })
    await userEvent.click(body.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(body.queryByRole("alertdialog")).toBeNull())
    expect(canvas.getByRole("link", { name: "Auth claims" })).toBeVisible()
    expect(requests).toEqual([])
  },
}

/** Confirming a delete sends one DELETE and removes the chat from the list. */
export const DeleteConfirm: Story = {
  beforeEach: () => {
    requests.length = 0
  },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () => new HttpResponse(null, { status: 204 }),
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await chooseAction(canvasElement, "Auth claims", "Delete")
    await body.findByRole("alertdialog", { name: "Delete this chat?" })
    await userEvent.click(body.getByRole("button", { name: "Delete chat" }))
    await waitFor(() =>
      expect(canvas.queryByRole("link", { name: "Auth claims" })).toBeNull(),
    )
    expect(canvas.getByRole("link", { name: "Repo layout" })).toBeVisible()
    // Focus moves to the next chat, not to the page body.
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: "Repo layout" })).toHaveFocus(),
    )
    expect(requests).toEqual(["DELETE /acme/api/v1/conversations/conv_2"])
  },
}

/** Deleting a chat that has one after it moves focus to the next chat. */
export const DeleteFirstFocusesNext: Story = {
  beforeEach: () => {
    requests.length = 0
  },
  args: { currentConversationId: "conv_2" },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () => new HttpResponse(null, { status: 204 }),
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await chooseAction(canvasElement, "Repo layout", "Delete")
    await userEvent.click(
      await body.findByRole("button", { name: "Delete chat" }),
    )
    await waitFor(() =>
      expect(canvas.queryByRole("link", { name: "Repo layout" })).toBeNull(),
    )
    await waitFor(() =>
      expect(canvas.getByRole("link", { name: "Auth claims" })).toHaveFocus(),
    )
  },
}

/** Deleting the open chat leaves it for the Workspace start page. */
export const DeleteOpenChatNavigatesAway: Story = {
  beforeEach: () => {
    requests.length = 0
  },
  args: { currentConversationId: "conv_2" },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () => new HttpResponse(null, { status: 204 }),
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await chooseAction(canvasElement, "Auth claims", "Delete")
    await userEvent.click(
      await body.findByRole("button", { name: "Delete chat" }),
    )
    await waitFor(() =>
      expect(
        within(canvasElement).getByText(/Story route: \/acme\/ws\//),
      ).toBeVisible(),
    )
    expect(requests).toEqual(["DELETE /acme/api/v1/conversations/conv_2"])
  },
}

/** A failed delete keeps the chat and shows the cause and a next step. */
export const DeleteError: Story = {
  beforeEach: () => {
    requests.length = 0
  },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () =>
            HttpResponse.json(
              { error: "Database unavailable" },
              { status: 500 },
            ),
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await chooseAction(canvasElement, "Auth claims", "Delete")
    await userEvent.click(
      await body.findByRole("button", { name: "Delete chat" }),
    )
    const alert = await canvas.findByRole("alert")
    await waitFor(() =>
      expect(alert).toHaveTextContent("The chat was not deleted"),
    )
    expect(alert).toHaveTextContent("Database unavailable")
    expect(alert).toHaveTextContent("Try again")
    expect(canvas.getByRole("link", { name: "Auth claims" })).toBeVisible()
  },
}

/** A chat with a running turn is not deleted. The message says how to stop the turn. */
export const DeleteRefusedWhileTurnRuns: Story = {
  beforeEach: () => {
    requests.length = 0
  },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () =>
            HttpResponse.json({ error: "turn_running" }, { status: 409 }),
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await chooseAction(canvasElement, "Auth claims", "Delete")
    await userEvent.click(
      await body.findByRole("button", { name: "Delete chat" }),
    )
    const alert = await canvas.findByRole("alert")
    await waitFor(() =>
      expect(alert).toHaveTextContent("A turn is still running in this chat"),
    )
    expect(alert).toHaveTextContent("select Stop")
    // A retry fails the same way, so only Dismiss shows.
    expect(canvas.queryByRole("button", { name: "Try again" })).toBeNull()
    expect(canvas.getByRole("button", { name: "Dismiss" })).toBeVisible()
    expect(canvas.getByRole("link", { name: "Auth claims" })).toBeVisible()
  },
}
