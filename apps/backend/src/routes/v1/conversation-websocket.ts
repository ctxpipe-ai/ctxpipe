import { and, eq } from "drizzle-orm"

import { getAuth } from "../../auth/config.js"
import { withUserIdContext } from "../../auth/context.js"
import { isAllowedRequestOrigin } from "../../auth/request-origin.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { members, organizations } from "../../db/schema/auth.js"
import {
  type ConversationChatRequest,
  parseConversationChatRequest,
} from "../../domain/conversations/transport.js"
import { stoppingSandboxWhenDone } from "../../domain/workspaces/conversation-sandbox-lifecycle.js"
import {
  conversationHasStoredTurns,
  streamTanstackWorkspaceChat,
} from "../../domain/workspaces/tanstack-workspace-chat.js"
import { workspaceChatRunError } from "../../domain/workspaces/workspace-chat-agui.js"
import { workspaceChatPersistence } from "../../domain/workspaces/workspace-chat-persistence.js"
import {
  persistWorkspaceChatUserTurnListed,
  resolveWorkspaceChatSendRuntime,
} from "../../domain/workspaces/workspace-chat-send-runtime.js"
import { discardUnstartedConversation } from "../../models/conversations.js"
import {
  createLogger,
  type LoggerHolder,
  log,
  loggerStorage,
} from "../../observability/logger.js"
import {
  type BunWebSocketLike,
  bunSocketToWebSocketLike,
  conversationWebSocketHasResumeOffset,
  isWorkspaceChatWebSocketRequest,
  parseConversationWebSocketUpgradeUrl,
  startConversationChatSocket,
} from "./conversation-websocket-stream.js"
import { getReadableConversation } from "./conversations.js"

export {
  type BunWebSocketLike,
  bunSocketToWebSocketLike,
  isWorkspaceChatWebSocketRequest,
} from "./conversation-websocket-stream.js"

export type ConversationWebSocketData = {
  kind: "workspace-chat"
  orgSlug: string
  orgId: string
  conversationId: string
  userId: string
  request: Request
  socket: BunWebSocketLike
}

type UpgradeServer = {
  upgrade: (
    request: Request,
    options: { data: ConversationWebSocketData },
  ) => boolean
}

type ChatSocket = {
  data: ConversationWebSocketData
  readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

/**
 * Upgrade a chat WebSocket. A browser sends the session cookie on a
 * WebSocket from any page, so the upgrade needs an `Origin` of this app,
 * by the same rule as `/mcp`. A chat turn changes the conversation, so an
 * API key, which is read-only, cannot open the socket.
 */
export async function handleConversationWebSocket(
  request: Request,
  server: UpgradeServer,
  env: Pick<Env, "AUTH_BASE_URL" | "AUTH_ALLOWED_ORIGINS">,
): Promise<Response | undefined> {
  if (!isWorkspaceChatWebSocketRequest(request)) return undefined
  const parsedUrl = parseConversationWebSocketUpgradeUrl(request.url)
  const orgSlug = parsedUrl?.orgSlug
  const conversationId = parsedUrl?.conversationId
  if (!orgSlug || !conversationId) {
    return new Response("Not found", { status: 404 })
  }
  const origin = request.headers.get("origin")
  if (!origin || !isAllowedRequestOrigin(env, origin)) {
    return new Response("Forbidden", { status: 403 })
  }
  if (request.headers.has("x-api-key")) {
    return new Response("Forbidden", { status: 403 })
  }

  const auth = getAuth()
  const authSession = await auth.api.getSession({
    headers: request.headers,
  })
  if (!authSession?.user || !authSession.session) {
    return new Response("Unauthorized", { status: 401 })
  }

  const orgRows = await getSystemDb()
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, organizations.id),
        eq(members.userId, authSession.user.id),
      ),
    )
    .where(eq(organizations.slug, orgSlug))
    .limit(1)
  const org = orgRows[0]
  if (!org) return new Response("Not found", { status: 404 })
  // A resume replays a stored run, so the user must be able to read the
  // conversation. A turn checks the conversation when it starts.
  if (conversationWebSocketHasResumeOffset(request.url)) {
    const userId = authSession.user.id
    const readable = await withOrgIdContext({ id: org.id, slug: orgSlug }, () =>
      withUserIdContext(userId, () =>
        getReadableConversation(conversationId, {
          orgId: org.id,
          headers: request.headers,
        }),
      ),
    )
    if (!readable) return new Response("Not found", { status: 404 })
  }

  const socket = bunSocketToWebSocketLike({
    send: () => {
      /* replaced after upgrade */
    },
    close: () => {
      /* replaced after upgrade */
    },
  })
  const upgraded = server.upgrade(request, {
    data: {
      kind: "workspace-chat",
      orgSlug,
      orgId: org.id,
      conversationId,
      userId: authSession.user.id,
      request,
      socket,
    },
  })
  if (!upgraded) {
    return new Response("WebSocket upgrade failed", { status: 500 })
  }
  return undefined
}

export const conversationWebSocketHandlers = {
  open(ws: ChatSocket) {
    const like = ws.data.socket
    like.send = (data) => {
      ws.send(data)
    }
    like.close = (code, reason) => {
      ws.close(code, reason)
    }
    startConversationChatSocket(
      like,
      ws.data.request,
      {
        orgId: ws.data.orgId,
        userId: ws.data.userId,
        conversationId: ws.data.conversationId,
      },
      (ctx) =>
        streamWorkspaceChatSocketTurn({
          conversationId: ws.data.conversationId,
          orgId: ws.data.orgId,
          orgSlug: ws.data.orgSlug,
          userId: ws.data.userId,
          messages: ctx.messages,
          threadId: ctx.threadId,
          runId: ctx.runId,
          forwardedProps: ctx.forwardedProps,
          signal: ctx.signal,
        }),
      { endLostRun: (runId) => endLostRun(ws.data, runId) },
    )
  },

  message(ws: ChatSocket, raw: string | ArrayBuffer | Uint8Array) {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    ws.data.socket.dispatchMessage(text)
  },

  close(ws: ChatSocket) {
    ws.data.socket.dispatchClose()
  },
}

/**
 * A run that is marked as running, but that no turn runs, stopped with its
 * process (a deploy or a crash). Mark it as aborted, so that the chat shows
 * a stopped turn and a push or a pull request is not blocked.
 */
async function endLostRun(data: ConversationWebSocketData, runId: string) {
  await withOrgIdContext({ id: data.orgId, slug: data.orgSlug }, () =>
    withUserIdContext(data.userId, async () => {
      const runs = workspaceChatPersistence({
        threadId: data.conversationId,
      }).stores.runs
      const run = await runs.get(runId)
      if (run?.threadId !== data.conversationId || run.status !== "running")
        return
      await runs.update(runId, { status: "aborted", finishedAt: Date.now() })
      log.warn({
        step: "workspace-chat-lost-run",
        message: "Marked a run with no live turn as aborted",
        conversationId: data.conversationId,
        runId,
      })
    }),
  )
}

async function* streamWorkspaceChatSocketTurn(input: {
  conversationId: string
  orgId: string
  orgSlug: string
  userId: string
  messages: unknown
  threadId: string
  runId: string
  forwardedProps?: Record<string, unknown>
  signal: AbortSignal
}) {
  // toWebSocketStream already validated the official run. Reconstruct the
  // same AG-UI body (tools/context/state are required arrays/objects) so the
  // shared HTTP parser can extract the prompt without a second-frame failure.
  const body = {
    messages: input.messages,
    threadId: input.threadId,
    runId: input.runId,
    tools: [],
    context: [],
    state: {},
    forwardedProps: input.forwardedProps ?? {},
  }
  let parsed: ConversationChatRequest
  try {
    parsed = await parseConversationChatRequest(body)
  } catch (error) {
    log.error({
      step: "workspace-chat-ws-parse",
      message: error instanceof Error ? error.message : String(error),
    })
    yield workspaceChatRunError("Invalid AG-UI frame")
    return
  }
  if (!parsed.prompt || !parsed.workspaceId.trim()) {
    yield workspaceChatRunError("workspace_required")
    return
  }
  const stream = streamTanstackWorkspaceChat({
    conversationId: input.conversationId,
    prompt: parsed.prompt,
    messages: parsed.messages,
    threadId: parsed.threadId ?? input.conversationId,
    runId: parsed.runId ?? input.runId,
    abortSignal: input.signal,
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    userId: input.userId,
    source: parsed.source,
    workspaceId: parsed.workspaceId,
    writeStatus: "read_only",
    resolveRuntime: () =>
      resolveWorkspaceChatSendRuntime({
        conversationId: input.conversationId,
        workspaceId: parsed.workspaceId,
        source: parsed.source,
      }),
    onUserPersist: () =>
      persistWorkspaceChatUserTurnListed(input.conversationId),
    onError: async () => {
      if (!(await conversationHasStoredTurns(input.conversationId))) {
        await discardUnstartedConversation(input.conversationId)
      }
    },
  })
  yield* withSocketTurnContext(
    { id: input.orgId, slug: input.orgSlug },
    input.userId,
    input.conversationId,
    // Only the UI is a person watching; any other caller frees its slot.
    parsed.source === "ui"
      ? stream
      : stoppingSandboxWhenDone(
          { orgId: input.orgId, conversationId: input.conversationId },
          stream,
        ),
  )
}

/**
 * Run each step of a socket turn in the auth and logger context. The turn
 * attribution comes from `beginWorkspaceChatTurn`.
 */
async function* withSocketTurnContext<T>(
  org: { id: string; slug: string },
  userId: string,
  conversationId: string,
  stream: AsyncIterable<T>,
): AsyncGenerator<T> {
  const logger = createLogger({
    step: "workspace-chat-ws",
    conversationId,
    orgSlug: org.slug,
  })
  const holder: LoggerHolder = { logger, base: { ...logger.getContext() } }
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await loggerStorage.run(holder, () =>
        withOrgIdContext(org, () =>
          withUserIdContext(userId, () => iterator.next()),
        ),
      )
      if (next.done) return
      yield next.value
    }
  } finally {
    holder.logger.emit()
  }
}
