import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  expectBoxUnchanged,
  responseGate,
} from "@/components/ui/skeletonMatchStory"
import type { ConversationLastTurn } from "@/features/chat/types"
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

let startingDeletes = 0

/**
 * A prepare (sandbox resume) still holds the chat after the backend waited:
 * the delete answers 409 chat_starting. The message says the chat starts and
 * offers Try again. It does not tell the user to stop a turn.
 */
export const DeleteWhileChatStarts: Story = {
  beforeEach: () => {
    requests.length = 0
    startingDeletes = 0
  },
  parameters: {
    msw: {
      handlers: {
        page: conversationRequestHandlers({
          del: () =>
            startingDeletes++ === 0
              ? HttpResponse.json({ error: "chat_starting" }, { status: 409 })
              : new HttpResponse(null, { status: 204 }),
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
      expect(alert).toHaveTextContent(
        "The chat is starting. Try again in a few seconds.",
      ),
    )
    expect(alert).not.toHaveTextContent(/turn|Stop|chat_starting/)
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }))
    await waitFor(() =>
      expect(canvas.queryByRole("link", { name: "Auth claims" })).toBeNull(),
    )
    expect(canvas.queryByRole("alert")).toBeNull()
    expect(requests).toEqual([
      "DELETE /acme/api/v1/conversations/conv_2",
      "DELETE /acme/api/v1/conversations/conv_2",
    ])
  },
}

const PREFERENCES_KEY = "ctxpipe:userPreferences"

/** What the browser stored about the chats the user has seen. */
function seedSeen(seen: Record<string, number>) {
  window.localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({ seenConversations: seen }),
  )
  return () => window.localStorage.removeItem(PREFERENCES_KEY)
}

/** The chat link is read again on each try, because the list can render it again. */
async function expectStatus(
  canvasElement: HTMLElement,
  chat: string,
  description: string,
  timeout = 1000,
) {
  const canvas = within(canvasElement)
  await waitFor(
    () =>
      expect(
        canvas.getByRole("link", { name: chat }),
      ).toHaveAccessibleDescription(description),
    { timeout },
  )
}

const statusChats = (
  turns: Record<string, ConversationLastTurn | null>,
): typeof docsConversations =>
  Object.entries(turns).map(([name, lastTurn], index) => ({
    ...docsConversations[0],
    id: `conv_${index + 1}`,
    name,
    lastTurn,
  }))

/** The four states, and each cause of "needs attention", with a label that is not only color. */
export const StatusDots: Story = {
  args: { currentConversationId: undefined },
  beforeEach: () => seedSeen({ conv_1: 100, conv_2: 100, conv_4: 100 }),
  parameters: {
    msw: {
      handlers: {
        page: [
          conversationsListHandler(
            statusChats({
              "Idle chat": { status: "completed", at: 100 },
              "Unread chat": { status: "completed", at: 200 },
              "Working chat": { status: "running", at: Date.now() },
              "Failed chat": { status: "failed", at: 400 },
              "Stopped chat": { status: "aborted", at: 500 },
              "Waiting chat": { status: "interrupted", at: 600 },
              "New chat": null,
            }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const describedAs = async (name: string, description: string) => {
      const link = await canvas.findByRole("link", { name })
      await waitFor(() => expect(link).toHaveAccessibleDescription(description))
    }
    await describedAs("Idle chat", "Idle")
    await describedAs("Unread chat", "Finished. You have not opened it yet.")
    await describedAs("Working chat", "Working")
    await describedAs("Failed chat", "Needs attention. The turn failed.")
    await describedAs(
      "Stopped chat",
      "Needs attention. The turn stopped before it finished.",
    )
    await describedAs(
      "Waiting chat",
      "Needs attention. The agent waits for you.",
    )
    await describedAs("New chat", "Idle")
    const statuses = [...canvasElement.querySelectorAll("[data-status]")].map(
      (dot) => dot.getAttribute("data-status"),
    )
    expect(statuses).toEqual([
      "idle",
      "unread",
      "working",
      "attention",
      "attention",
      "attention",
      "idle",
    ])
  },
}

/** A running row older than the backend turn limit is lost: orange, no spinner. */
export const StaleRunningChat: Story = {
  args: { currentConversationId: undefined },
  parameters: {
    msw: {
      handlers: {
        page: [
          conversationsListHandler(
            statusChats({
              "Lost chat": {
                status: "running",
                at: Date.now() - 3 * 60 * 60_000,
              },
            }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", { name: "Lost chat" })
    await waitFor(() =>
      expect(link).toHaveAccessibleDescription(
        "Needs attention. The turn stopped before it finished.",
      ),
    )
    expect(canvasElement.querySelector("[data-status]")).toHaveAttribute(
      "data-status",
      "attention",
    )
  },
}

/** The rail has no room for names, so each dot is a badge on the initials. */
export const StatusDotsCollapsed: Story = {
  args: { navExpanded: false, currentConversationId: undefined },
  beforeEach: () => seedSeen({ conv_1: 100 }),
  parameters: {
    msw: {
      handlers: {
        page: [
          conversationsListHandler(
            statusChats({
              "Unread chat": { status: "completed", at: 200 },
              "Working chat": { status: "running", at: Date.now() },
              "Failed chat": { status: "failed", at: 400 },
            }),
          ),
        ],
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", { name: "Working chat" })
    await waitFor(() => expect(link).toHaveAccessibleDescription("Working"))
    expect(
      canvas.getByRole("link", { name: "Failed chat" }),
    ).toHaveAccessibleDescription("Needs attention. The turn failed.")
  },
}

/** The list with an open chat that follows the chat the user selects. */
function OpensChats(props: ComponentProps<typeof WorkspaceConversationList>) {
  const [open, setOpen] = useState<string | undefined>(undefined)
  return (
    <WorkspaceConversationList
      {...props}
      currentConversationId={open}
      onSelectNav={(next) => setOpen(next.conversationId)}
    />
  )
}

/**
 * The list reads the chat status again while a chat works. One chat works,
 * then finishes: the dot goes from the spinner to unread. Opening the chat
 * marks it read, and the list stops reading when no chat works.
 */
const finishRequests = { count: 0 }
export const WorkingThenUnreadThenRead: Story = {
  beforeEach: () => {
    finishRequests.count = 0
    return seedSeen({ conv_1: 500 })
  },
  args: { currentConversationId: undefined },
  render: (args) => <OpensChats {...args} />,
  parameters: {
    // Selecting a chat goes to its route. The list stays, as in the Workspace layout.
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: docsWorkspace.slug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations$/.test(new URL(request.url).pathname),
            () => {
              finishRequests.count += 1
              const lastTurn: ConversationLastTurn =
                finishRequests.count < 2
                  ? { status: "running", at: Date.now() }
                  : { status: "completed", at: 2000 }
              return HttpResponse.json({
                items: statusChats({ "Billing questions": lastTurn }),
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
    await canvas.findByRole("link", { name: "Billing questions" })
    await expectStatus(canvasElement, "Billing questions", "Working")
    // The next read shows the finished turn. The user is not in the chat.
    await expectStatus(
      canvasElement,
      "Billing questions",
      "Finished. You have not opened it yet.",
      8000,
    )
    // No chat works now, so the list stops reading.
    const reads = finishRequests.count
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(finishRequests.count).toBe(reads)
    await userEvent.click(
      canvas.getByRole("link", { name: "Billing questions" }),
    )
    await expectStatus(canvasElement, "Billing questions", "Idle")
  },
}

const failRequests = { count: 0 }
/** A turn that works and then fails turns the dot orange. It stays orange after the chat is opened. */
export const WorkingThenNeedsAttention: Story = {
  beforeEach: () => {
    failRequests.count = 0
    return seedSeen({ conv_1: 500 })
  },
  args: { currentConversationId: undefined },
  render: (args) => <OpensChats {...args} />,
  parameters: {
    // Selecting a chat goes to its route. The list stays, as in the Workspace layout.
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: docsWorkspace.slug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations$/.test(new URL(request.url).pathname),
            () => {
              failRequests.count += 1
              const lastTurn: ConversationLastTurn =
                failRequests.count < 2
                  ? { status: "running", at: Date.now() }
                  : { status: "failed", at: 2000 }
              return HttpResponse.json({
                items: statusChats({ "Billing questions": lastTurn }),
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
    await canvas.findByRole("link", { name: "Billing questions" })
    await expectStatus(canvasElement, "Billing questions", "Working")
    const failed = "Needs attention. The turn failed."
    await expectStatus(canvasElement, "Billing questions", failed, 8000)
    await userEvent.click(
      canvas.getByRole("link", { name: "Billing questions" }),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("link", { name: "Billing questions" }),
      ).toHaveAttribute("aria-current", "page"),
    )
    // Opening the chat does not clear the cause. A retry or a new turn does.
    await expectStatus(canvasElement, "Billing questions", failed)
  },
}
