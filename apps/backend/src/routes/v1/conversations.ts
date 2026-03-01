import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import {
  createHttpConversationTransport,
  loadConversationUiMessages,
  toPromptFromIncomingMessage,
} from "../../domain/conversations/transport.js"
import {
  ensureConversation,
  getConversation,
  listConversations,
  touchConversationLastMessage,
} from "../../models/conversations.js"

const ErrorResponseSchema = z.object({ error: z.string() }).openapi("ErrorResponse")

const ConversationSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    name: z.string(),
    source: z.string(),
    lastMessageAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Conversation")

const ConversationListResponseSchema = z
  .object({
    items: z.array(ConversationSchema),
  })
  .openapi("ConversationListResponse")

const ListConversationsQuerySchema = z
  .object({
    source: z.string().optional().default("ui"),
  })
  .openapi("ListConversationsQuery")

const ConversationParamsSchema = z
  .object({
    conversationId: z.string().min(1),
  })
  .openapi("ConversationParams")

const IncomingMessageSchema = z
  .object({
    role: z.string(),
    content: z.unknown().optional(),
    parts: z.array(z.unknown()).optional(),
  })
  .passthrough()
  .openapi("IncomingChatMessage")

const CreateConversationMessageRequestSchema = z
  .object({
    message: IncomingMessageSchema,
    source: z.string().optional().default("ui"),
  })
  .openapi("CreateConversationMessageRequest")

const ConversationDetailResponseSchema = z
  .object({
    conversation: ConversationSchema,
    messages: z.array(z.unknown()),
  })
  .openapi("ConversationDetailResponse")

const listConversationsRoute = createRoute({
  method: "get",
  path: "/",
  request: {
    query: ListConversationsQuerySchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: ConversationListResponseSchema } },
      description: "Conversation list",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

const getConversationRoute = createRoute({
  method: "get",
  path: "/{conversationId}",
  request: {
    params: ConversationParamsSchema,
  },
  responses: {
    200: {
      content: { "application/json": { schema: ConversationDetailResponseSchema } },
      description: "Conversation details and messages",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
  },
})

const postConversationMessageRoute = createRoute({
  method: "post",
  path: "/{conversationId}",
  request: {
    params: ConversationParamsSchema,
    body: {
      content: {
        "application/json": {
          schema: CreateConversationMessageRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Streaming response",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Bad request",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
  },
})

export const conversationRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listConversationsRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const source = c.req.query("source") ?? "ui"
    const rows = await listConversations({
      source: source === "all" ? undefined : source,
    })
    const items = rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    }))
    return c.json({ items }, 200)
  })
  .openapi(getConversationRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const conversation = await getConversation(conversationId)
    if (!conversation) return c.json({ error: "Not found" }, 404)

    const messages = await loadConversationUiMessages({
      conversationId,
      checkpointNamespace: "",
    })

    return c.json(
      {
        conversation: {
          ...conversation,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
          lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        },
        messages,
      },
      200,
    )
  })
  .openapi(postConversationMessageRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const body = CreateConversationMessageRequestSchema.parse(await c.req.json())
    const prompt = toPromptFromIncomingMessage(body.message)
    if (prompt.length === 0) {
      return c.json({ error: "Message text is required" }, 400)
    }

    await ensureConversation({ id: conversationId, source: body.source })

    const protocol =
      c.req.query("protocol") === "text" ? "text" : ("data" as const)
    const transport = createHttpConversationTransport(protocol)

    return transport.toResponse({
      conversationId,
      checkpointNamespace: "",
      prompt,
      onFinish: async () => {
        await touchConversationLastMessage(conversationId)
      },
    })
  })
