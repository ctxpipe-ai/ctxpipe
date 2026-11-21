import { HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  expectBoxUnchanged,
  responseGate,
} from "@/components/ui/skeletonMatchStory"
import type { ConversationLastTurn } from "@/features/chat/types"
import { signedInHandlers } from "@/mocks/handlers"
import {
  conversationDetailHandler,
  conversationGitTreeHandler,
  conversationsListHandler,
  conversationsListLoadingHandler,
} from "@/mocks/workspace-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import {
  docsConversationDetail,
  docsConversations,
  docsWorkspace,
} from "./workspace-fixtures"
import { WorkspaceConversationList } from "./WorkspaceConversationList"

const meta = preview.meta({
  title: "Components/Workspaces/ConversationList",
  component: WorkspaceConversationList,
  decorators: [
    (Story) => (
      <div className="w-64 bg-zinc-950 py-2">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
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
})

/**
 * Conversation list of a Workspace in the side nav, where a member opens a
 * chat: a few chats, and the open chat is selected.
 */
export const WithConversations = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(conversationsListHandler(docsConversations))
  },
})

/**
 * Conversation list of a Workspace in the side nav: a file is open, so the chat
 * links go to the files pane and not to that file.
 */
export const SwitchFromOpenFile = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(conversationsListHandler(docsConversations))
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as WithConversations.",
    },
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
      search: "?pane=file%3Aa.md",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", { name: "Auth claims" })
    const href = link.getAttribute("href") ?? ""
    await expect(href).toContain("pane=files")
    await expect(href).not.toContain("a.md")
    const current = await canvas.findByRole("link", { name: "Repo layout" })
    await expect(current.getAttribute("href") ?? "").toContain(
      "pane=file%3Aa.md",
    )
  },
})

/**
 * Conversation list of a Workspace in the side nav, where a member opens a
 * chat: the Workspace has no chats yet, so a short line says so.
 */
export const Empty = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(conversationsListHandler([]))
  },
})

/**
 * Conversation list of a Workspace in the side nav, where a member opens a
 * chat: the chats still load, so skeleton rows show.
 */
export const Loading = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(conversationsListLoadingHandler())
  },
})

/**
 * Conversation list of a Workspace in the side nav, where a member opens a
 * chat: the server has more chats than the first page, so a Load more control
 * shows.
 */
export const LoadMore = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      conversationsListHandler(docsConversations, {
        hasNextPage: true,
        hasPreviousPage: false,
        startCursor: "conv_1",
        endCursor: "conv_2",
      }),
    )
  },
})

/**
 * Conversation list of a Workspace in the collapsed side nav rail: each chat
 * shows as initials with no name.
 */
export const Collapsed = meta.story({
  args: {
    navExpanded: false,
  },
  decorators: [
    (Story) => (
      <div className="w-16 bg-zinc-950 py-2">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(conversationsListHandler(docsConversations))
  },
})

const conversationsGate = responseGate()
const threeConversations = [
  "Billing structure",
  "Auth claims",
  "Refund rules",
].map((name, row) => ({ ...docsConversations[0], id: `conv_${row + 1}`, name }))

/**
 * Conversation list of a Workspace in the side nav, with three loaded chats.
 * The loaded rows fill the same box as the skeleton rows before them.
 */
export const ConversationListSkeletonMatches = meta.story({
  tags: ["required"],
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
  },
  parameters: {
    intent:
      "Catches a conversation list skeleton whose box differs from the loaded list. This causes layout shift when the data arrives. Not for conversation titles or order.",
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
          canvas.getByRole("link", { name: "Refund rules" }),
        ).toBeVisible(),
      )
    })
  },
})

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

/**
 * Conversation list of a Workspace in the side nav. Keyboard focus shows the
 * Actions button of a chat, and its menu with Rename and Delete is open.
 */
export const ActionsMenuByKeyboard = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () => new HttpResponse(null, { status: 204 }),
      }),
    )
    requests.length = 0
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
})

/**
 * Conversation list of a Workspace in the side nav. The member renamed a chat
 * in its row, and the new name shows. The play proves that Enter saves the name
 * one time.
 */
export const RenameFromMenu = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () => new HttpResponse(null, { status: 204 }),
      }),
    )
    requests.length = 0
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
})

/**
 * Conversation list of a Workspace in the side nav. The member pressed Escape
 * during a rename, so the chat keeps its old name and no request goes out.
 */
export const RenameCancelWithEscape = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () => new HttpResponse(null, { status: 204 }),
      }),
    )
    requests.length = 0
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
})

/**
 * Conversation list of a Workspace in the side nav. Delete asks first, and the
 * member canceled the dialog. The chat stays in the list, and no request goes
 * out.
 */
export const DeleteCancel = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () => new HttpResponse(null, { status: 204 }),
      }),
    )
    requests.length = 0
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as WithConversations, with only a focus ring more.",
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
})

/**
 * Conversation list of a Workspace in the side nav. The member deleted a chat
 * from its menu and confirmed. One DELETE goes out, the chat is gone, and one
 * chat stays.
 */
export const DeleteConfirm = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () => new HttpResponse(null, { status: 204 }),
      }),
    )
    requests.length = 0
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
})

/**
 * Conversation list of a Workspace in the side nav. The member deleted a chat
 * that has a chat after it, and focus moved to the next chat.
 */
export const DeleteFirstFocusesNext = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () => new HttpResponse(null, { status: 204 }),
      }),
    )
    requests.length = 0
  },
  args: { currentConversationId: "conv_2" },
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
})

/**
 * Conversation list of a Workspace in the side nav. The member deleted the open
 * chat, and the app went to the Workspace start page.
 */
export const DeleteOpenChatNavigatesAway = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () => new HttpResponse(null, { status: 204 }),
      }),
    )
    requests.length = 0
  },
  args: { currentConversationId: "conv_2" },
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a story route marker, which the product does not render.",
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
})

/**
 * Conversation list of a Workspace in the side nav. The delete request of a
 * chat failed, so the chat stays, and an alert gives the cause and a next step.
 */
export const DeleteError = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () =>
          HttpResponse.json({ error: "Database unavailable" }, { status: 500 }),
      }),
    )
    requests.length = 0
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
})

/**
 * Conversation list of a Workspace in the side nav. The delete failed because a
 * turn runs in the chat, so the chat stays, and the message tells how to stop
 * the turn.
 */
export const DeleteRefusedWhileTurnRuns = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () =>
          HttpResponse.json({ error: "turn_running" }, { status: 409 }),
      }),
    )
    requests.length = 0
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
})

let startingDeletes = 0

/**
 * Conversation list of a Workspace in the side nav. The delete failed with 409
 * `chat_starting`, because a prepare (sandbox resume) still holds the chat. The
 * message says that the chat starts and offers Try again. It does not tell the
 * user to stop a turn.
 */
export const DeleteWhileChatStarts = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...conversationRequestHandlers({
        del: () =>
          startingDeletes++ === 0
            ? HttpResponse.json({ error: "chat_starting" }, { status: 409 })
            : new HttpResponse(null, { status: 204 }),
      }),
    )
    requests.length = 0
    startingDeletes = 0
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as DeleteConfirm.",
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
})

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

/**
 * Conversation list of a Workspace in the side nav. Each chat has a status dot
 * for idle, unread, working, or needs attention, with a text label, so the
 * state is not only a color. Each cause of needs attention has its own row.
 */
export const StatusDots = meta.story({
  args: { currentConversationId: undefined },
  beforeEach: ({ msw }) => {
    msw.use(
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
    )
    return seedSeen({ conv_1: 100, conv_2: 100, conv_4: 100 })
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
})

/**
 * Conversation list of a Workspace in the side nav. A chat runs past the
 * backend turn limit, so the chat counts as lost: its dot is orange, with no
 * spinner.
 */
export const StaleRunningChat = meta.story({
  args: { currentConversationId: undefined },
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
  beforeEach: ({ msw }) => {
    msw.use(
      conversationsListHandler(
        statusChats({
          "Lost chat": {
            status: "running",
            at: Date.now() - 3 * 60 * 60_000,
          },
        }),
      ),
    )
  },
})

/**
 * Conversation list of a Workspace in the collapsed side nav rail. The rail has
 * no room for names, so each status dot is a badge on the chat initials.
 */
export const StatusDotsCollapsed = meta.story({
  args: { navExpanded: false, currentConversationId: undefined },
  beforeEach: ({ msw }) => {
    msw.use(
      conversationsListHandler(
        statusChats({
          "Unread chat": { status: "completed", at: 200 },
          "Working chat": { status: "running", at: Date.now() },
          "Failed chat": { status: "failed", at: 400 },
        }),
      ),
    )
    return seedSeen({ conv_1: 100 })
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
})

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
/**
 * Conversation list of a Workspace in the side nav: a working chat finished and
 * became unread, and the member opened it, so it is read.
 */
export const WorkingThenUnreadThenRead = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
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
      conversationDetailHandler(docsConversationDetail),
      conversationGitTreeHandler(),
    )
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
})

const failRequests = { count: 0 }
/**
 * Conversation list of a Workspace in the side nav. A working chat failed, so
 * its dot turned orange. The dot stays orange after the member opens the chat.
 */
export const WorkingThenNeedsAttention = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
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
      conversationDetailHandler(docsConversationDetail),
      conversationGitTreeHandler(),
    )
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
})
