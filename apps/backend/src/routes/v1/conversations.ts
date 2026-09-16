import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { AppEnv } from "../../app/env.js"
import { hasOrgAdminOrOwnerRole } from "../../auth/withAuth.js"
import { filterInternalNodeMessageChunks } from "../../domain/conversations/internalNodeMessageFilter.js"
import { createRenameStreamEnhancer } from "../../domain/conversations/renameStream.js"
import {
  createDataStreamConversationTransport,
  loadConversationUiMessages,
  toPromptFromIncomingMessage,
} from "../../domain/conversations/transport.js"
import { PageInfoSchema } from "../../lib/pagination.js"
import {
  deleteConversation,
  ensureConversation,
  getConversation,
  listConversationsPaginated,
  touchConversationLastMessage,
  updateConversation,
} from "../../models/conversations.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse")

const ConversationSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    userId: z.string().nullable(),
    name: z.string(),
    source: z.string().nullable(),
    lastMessageAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Conversation")

const ConversationListResponseSchema = z
  .object({
    items: z.array(ConversationSchema),
    pageInfo: PageInfoSchema,
  })
  .openapi("ConversationListResponse")

const ListConversationsQuerySchema = z
  .object({
    source: z.string().optional(),
    first: z.coerce.number().int().min(1).max(100).optional().default(10),
    after: z.string().optional(),
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
    source: z.string().optional(),
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
      content: {
        "application/json": { schema: ConversationListResponseSchema },
      },
      description: "Conversation list",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
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
      content: {
        "application/json": { schema: ConversationDetailResponseSchema },
      },
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

const UpdateConversationRequestSchema = z
  .object({
    name: z.string().min(1),
  })
  .openapi("UpdateConversationRequest")

const patchConversationRoute = createRoute({
  method: "patch",
  path: "/{conversationId}",
  request: {
    params: ConversationParamsSchema,
    body: {
      content: {
        "application/json": {
          schema: UpdateConversationRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ConversationSchema } },
      description: "Updated conversation",
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

const deleteConversationRoute = createRoute({
  method: "delete",
  path: "/{conversationId}",
  request: {
    params: ConversationParamsSchema,
  },
  responses: {
    204: {
      description: "Deleted",
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

async function isOrgAdminOrOwner(c: Context<AppEnv>): Promise<boolean> {
  const orgId = c.get("orgId")
  if (!orgId) return false
  return hasOrgAdminOrOwnerRole({
    headers: c.req.raw.headers,
    orgId,
  })
}

export const conversationRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listConversationsRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const query = ListConversationsQuerySchema.parse({
      source: c.req.query("source"),
      first: c.req.query("first"),
      after: c.req.query("after"),
    })

    const orgService = query.source === "mcp-service"
    if (orgService && !(await isOrgAdminOrOwner(c))) {
      return c.json({ error: "Forbidden" }, 403)
    }

    const { items: rows, pageInfo } = await listConversationsPaginated({
      source: orgService
        ? undefined
        : query.source === "all"
          ? undefined
          : query.source,
      orgService,
      first: query.first,
      after: query.after,
    })

    const items = rows.map((row) => ({
      ...row,
      userId: row.userId ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    }))
    return c.json({ items, pageInfo }, 200)
  })
  .openapi(getConversationRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    let conversation = await getConversation(conversationId)
    if (!conversation && (await isOrgAdminOrOwner(c))) {
      conversation = await getConversation(conversationId, { orgService: true })
    }
    if (!conversation) return c.json({ error: "Not found" }, 404)

    const messages = await loadConversationUiMessages({
      conversationId,
      checkpointNamespace: "",
    })

    return c.json(
      {
        conversation: {
          ...conversation,
          userId: conversation.userId ?? null,
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
          lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        },
        messages,
      },
      200,
    )
  })
  .openapi(patchConversationRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const body = UpdateConversationRequestSchema.parse(await c.req.json())
    let updated = await updateConversation(conversationId, {
      name: body.name,
    })
    if (!updated && (await isOrgAdminOrOwner(c))) {
      updated = await updateConversation(conversationId, {
        name: body.name,
        orgService: true,
      })
    }
    if (!updated) return c.json({ error: "Not found" }, 404)

    return c.json(
      {
        ...updated,
        userId: updated.userId ?? null,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
        lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
      },
      200,
    )
  })
  .openapi(deleteConversationRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    let deleted = await deleteConversation(conversationId)
    if (!deleted && (await isOrgAdminOrOwner(c))) {
      deleted = await deleteConversation(conversationId, { orgService: true })
    }
    if (!deleted) return c.json({ error: "Not found" }, 404)

    return c.body(null, 204)
  })
  .openapi(postConversationMessageRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const body = CreateConversationMessageRequestSchema.parse(
      await c.req.json(),
    )
    const prompt = toPromptFromIncomingMessage(body.message)
    if (prompt.length === 0) {
      return c.json({ error: "Message text is required" }, 400)
    }

    await ensureConversation({ id: conversationId, source: body.source })
    void touchConversationLastMessage(conversationId)

    const transport = createDataStreamConversationTransport()
    const internalFilterEnhancer = {
      wrapGraphStream(stream: AsyncIterable<unknown>) {
        return filterInternalNodeMessageChunks(stream)
      },
      getFlushTransform() {
        return new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk)
          },
        })
      },
    }
    const renameEnhancer = createRenameStreamEnhancer({
      source: body.source ?? undefined,
    })

    return transport.toResponse({
      conversationId,
      checkpointNamespace: "",
      prompt,
      source: body.source ?? null,
      streamEnhancers: [internalFilterEnhancer, renameEnhancer],
    })
  })
