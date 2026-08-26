import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import {
  type ConversationChatRequest,
  loadConversationUiMessages,
  parseConversationChatRequest,
  workspaceChatStreamResponse,
} from "../../domain/conversations/transport.js"
import {
  planChatPullRequest,
  shouldDestroyChatSandbox,
} from "../../domain/workspaces/chat-lifecycle.js"
import { workspaceAllowsConversationEdits } from "../../domain/workspaces/chat-sandbox-policy.js"
import { resolveConversationSandboxHandle } from "../../domain/workspaces/conversation-files.js"
import { pushConversationSessionBranch } from "../../domain/workspaces/conversation-publish.js"
import {
  destroySandboxesForConversation,
  getRegisteredChatSandbox,
  withDestroyedConversationSandboxes,
} from "../../domain/workspaces/sandbox-registry.js"
import {
  checkoutPreparedConversationBranch,
  conversationFileRoutes,
  conversationPublicPrUrl,
  conversationPublicTreeUrl,
} from "./conversation-files-routes.js"
import { reconstructChat } from "@tanstack/ai-persistence"
import {
  conversationHasStoredTurns,
  warmTanstackWorkspaceChat,
} from "../../domain/workspaces/tanstack-workspace-chat.js"
import { workspaceChatPersistence } from "../../domain/workspaces/workspace-chat-persistence.js"
import {
  persistWorkspaceChatUserTurnListed,
  resolveWorkspaceChatSendRuntime,
} from "../../domain/workspaces/workspace-chat-send-runtime.js"
import { resolveWorkspaceChatTurnRuntime } from "../../domain/workspaces/workspace-chat-turn-runtime.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { PageInfoSchema } from "../../lib/pagination.js"
import {
  deleteConversation,
  discardUnstartedConversation,
  ensureConversation,
  getConversation,
  listConversationsPaginated,
  persistConversationLastBranch,
  persistConversationLastChatPrNumber,
  updateConversation,
} from "../../models/conversations.js"
import { getInstallationToken } from "../../models/github-installation.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import {
  createPullRequestFromBranch,
  getPullRequestState,
} from "../../services/github/installation-write-client.js"
import { resolveGithubDefaultBranch } from "../webhooks/github/github-workspace-tip.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse")

const ConversationSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    userId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    name: z.string(),
    source: z.string().nullable(),
    lastBranch: z.string().nullable().optional(),
    lastChatPrNumber: z.number().int().nullable().optional(),
    lastChatPrUrl: z.string().nullable().optional(),
    prState: z.enum(["open", "closed", "merged"]).nullable().optional(),
    branchTreeUrl: z.string().nullable().optional(),
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
    workspaceId: z.string().min(1),
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
    message: IncomingMessageSchema.optional(),
    messages: z.array(z.unknown()).optional(),
    source: z.string().optional(),
    workspaceId: z.string().optional(),
    threadId: z.string().optional(),
    runId: z.string().optional(),
    forwardedProps: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
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
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Bad request",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Workspace required",
    },
  },
})

const GetConversationQuerySchema = z
  .object({
    workspaceId: z.string().optional(),
  })
  .openapi("GetConversationQuery")

const getConversationRoute = createRoute({
  method: "get",
  path: "/{conversationId}",
  request: {
    params: ConversationParamsSchema,
    query: GetConversationQuerySchema,
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
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Workspace required or conversation is already running a turn",
    },
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Failed to start the conversation stream",
    },
  },
})

const PrepareConversationRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
  })
  .openapi("PrepareConversationRequest")

const ReconstructChatResponseSchema = z
  .object({
    messages: z.array(z.unknown()),
    activeRun: z.object({ runId: z.string() }).nullable(),
    interrupts: z.unknown().nullable(),
  })
  .openapi("ReconstructChatResponse")

const getConversationChatRoute = createRoute({
  method: "get",
  path: "/{conversationId}/chat",
  request: {
    params: ConversationParamsSchema,
    query: GetConversationQuerySchema,
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ReconstructChatResponseSchema },
      },
      description: "Persisted TanStack chat transcript",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
  },
})

const postConversationPrepareRoute = createRoute({
  method: "post",
  path: "/{conversationId}/prepare",
  request: {
    params: ConversationParamsSchema,
    body: {
      content: {
        "application/json": { schema: PrepareConversationRequestSchema },
      },
    },
  },
  responses: {
    204: {
      description: "Workspace chat sandbox is warming",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Bad request",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Prepare failed",
    },
  },
})

const CreateConversationPullRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().optional(),
  })
  .openapi("CreateConversationPullRequest")

const ConversationPullRequestResponseSchema = z
  .object({
    branch: z.string(),
    prNumber: z.number().int(),
    pullUrl: z.string(),
    prState: z.enum(["open", "closed", "merged"]),
  })
  .openapi("ConversationPullRequestResponse")

const getConversationPullRequestRoute = createRoute({
  method: "get",
  path: "/{conversationId}/pull-request",
  request: { params: ConversationParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConversationPullRequestResponseSchema },
      },
      description: "Current conversation pull request",
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

const postConversationPullRequestRoute = createRoute({
  method: "post",
  path: "/{conversationId}/pull-request",
  request: {
    params: ConversationParamsSchema,
    body: {
      content: {
        "application/json": { schema: CreateConversationPullRequestSchema },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConversationPullRequestResponseSchema },
      },
      description: "Brokered pull request",
    },
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Refused",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Chat sandbox missing",
    },
  },
})

export const conversationRoutes = new OpenAPIHono<AppEnv>()
  .route("/", conversationFileRoutes)
  .openapi(listConversationsRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const query = ListConversationsQuerySchema.parse({
      workspaceId: c.req.query("workspaceId"),
      first: c.req.query("first"),
      after: c.req.query("after"),
    })
    if (!query.workspaceId.trim()) {
      return c.json({ error: "workspace_required" }, 409)
    }
    const { items: rows, pageInfo } = await listConversationsPaginated({
      source: "ui",
      workspaceId: query.workspaceId.trim(),
      first: query.first,
      after: query.after,
    })
    const listedWorkspace = await getWorkspaceById(query.workspaceId.trim())

    const items = rows.map((row) => ({
      ...row,
      userId: row.userId ?? null,
      workspaceId: row.workspaceId ?? null,
      lastBranch: row.lastBranch ?? null,
      lastChatPrNumber: row.lastChatPrNumber ?? null,
      lastChatPrUrl: conversationPublicPrUrl({
        workspaceRepositoryUrl:
          listedWorkspace?.workspaceRepositoryUrl ?? "",
        lastChatPrNumber: row.lastChatPrNumber ?? null,
      }),
      branchTreeUrl: conversationPublicTreeUrl({
        workspaceRepositoryUrl:
          listedWorkspace?.workspaceRepositoryUrl ?? "",
        lastBranch: row.lastBranch ?? null,
      }),
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
    const workspaceId = c.req.query("workspaceId")
    const conversation = await getConversation(conversationId, {
      workspaceId,
    })
    if (!conversation) return c.json({ error: "Not found" }, 404)

    const messages = await loadConversationUiMessages({
      conversationId,
      checkpointNamespace: "",
      workspaceId: conversation.workspaceId,
    })
    const detailWorkspace = conversation.workspaceId
      ? await getWorkspaceById(conversation.workspaceId)
      : null

    return c.json(
      {
        conversation: {
          ...conversation,
          userId: conversation.userId ?? null,
          workspaceId: conversation.workspaceId ?? null,
          lastBranch: conversation.lastBranch ?? null,
          lastChatPrNumber: conversation.lastChatPrNumber ?? null,
          lastChatPrUrl: conversationPublicPrUrl({
            workspaceRepositoryUrl:
              detailWorkspace?.workspaceRepositoryUrl ?? "",
            lastChatPrNumber: conversation.lastChatPrNumber ?? null,
          }),
          branchTreeUrl: conversationPublicTreeUrl({
            workspaceRepositoryUrl:
              detailWorkspace?.workspaceRepositoryUrl ?? "",
            lastBranch: conversation.lastBranch ?? null,
          }),
          createdAt: conversation.createdAt.toISOString(),
          updatedAt: conversation.updatedAt.toISOString(),
          lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        },
        messages,
      },
      200,
    )
  })
  .openapi(getConversationChatRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const workspaceId = c.req.query("workspaceId")
    const conversation = await getConversation(conversationId, {
      workspaceId,
    })
    if (!conversation) return c.json({ error: "Not found" }, 404)

    const url = new URL(c.req.url)
    url.searchParams.set("threadId", conversationId)
    const reconstructed = await reconstructChat(
      workspaceChatPersistence(),
      new Request(url),
      { authorize: async (threadId) => threadId === conversationId },
    )
    if (reconstructed.status === 403) {
      return c.json({ error: "Forbidden" }, 403)
    }
    return c.json(
      ReconstructChatResponseSchema.parse(await reconstructed.json()),
      200,
    )
  })
  .openapi(patchConversationRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const body = UpdateConversationRequestSchema.parse(await c.req.json())
    const updated = await updateConversation(conversationId, {
      name: body.name,
    })
    if (!updated) return c.json({ error: "Not found" }, 404)

    return c.json(
      {
        ...updated,
        userId: updated.userId ?? null,
        workspaceId: updated.workspaceId ?? null,
        lastBranch: updated.lastBranch ?? null,
        lastChatPrNumber: updated.lastChatPrNumber ?? null,
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
    const existing = await getConversation(conversationId)
    if (!existing) return c.json({ error: "Not found" }, 404)
    const shouldDestroy = shouldDestroyChatSandbox({
      conversationDeleted: true,
      lastTurnAt: existing.lastMessageAt ?? null,
      now: new Date(),
    })
    if (shouldDestroy) {
      const log = getLogger()
      log.set({
        conversationId,
        workspaceId: existing.workspaceId ?? null,
        sandbox: "chat",
      })
      log.info("destroy chat sandbox after conversation delete")
    }
    const deleted =
      shouldDestroy && existing.workspaceId
        ? await withDestroyedConversationSandboxes(
            {
              conversationId,
              orgId: existing.orgId,
              workspaceId: existing.workspaceId,
            },
            () => deleteConversation(conversationId),
          )
        : await deleteConversation(conversationId)
    if (!deleted) return c.json({ error: "Not found" }, 404)
    if (shouldDestroy && !existing.workspaceId) {
      await destroySandboxesForConversation(conversationId)
    }

    return c.body(null, 204)
  })
  .openapi(postConversationMessageRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    let parsed: ConversationChatRequest
    try {
      parsed = await parseConversationChatRequest(await c.req.json())
    } catch {
      return c.json({ error: "Message text is required" }, 400)
    }
    if (parsed.prompt.length === 0) {
      return c.json({ error: "Message text is required" }, 400)
    }
    if (!parsed.workspaceId.trim()) {
      return c.json({ error: "workspace_required" }, 400)
    }

    return workspaceChatStreamResponse(
      {
        conversationId,
        checkpointNamespace: "",
        prompt: parsed.prompt,
        messages: parsed.messages,
        threadId: parsed.threadId ?? conversationId,
        runId: parsed.runId,
        source: parsed.source ?? null,
        workspaceId: parsed.workspaceId,
        orgId: "",
        orgSlug: c.get("orgSlug"),
        resolveRuntime: () =>
          resolveWorkspaceChatSendRuntime({
            conversationId,
            workspaceId: parsed.workspaceId,
            source: parsed.source,
          }),
        onUserPersist: () => persistWorkspaceChatUserTurnListed(conversationId),
        onError: async () => {
          if (!(await conversationHasStoredTurns(conversationId))) {
            await discardUnstartedConversation(conversationId)
          }
        },
      },
      c.req.raw,
    )
  })
  .openapi(postConversationPrepareRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const body = PrepareConversationRequestSchema.parse(await c.req.json())
    const conversation = await ensureConversation({
      id: conversationId,
      source: "ui",
      workspaceId: body.workspaceId,
    })
    const workspace = conversation.workspaceId
      ? await getWorkspaceById(conversation.workspaceId)
      : null
    if (!workspace?.workspaceRepositoryUrl) {
      return c.json({ error: "workspace_required" }, 400)
    }
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const runtime = await resolveWorkspaceChatTurnRuntime({
      conversation,
      workspace,
      env,
    })
    if (!runtime.desiredUrl) {
      return c.json({ error: "workspace_required" }, 400)
    }
    const warmed = await warmTanstackWorkspaceChat({
      conversationId,
      prompt: "prepare",
      orgId: runtime.orgId,
      workspaceId: runtime.workspaceId ?? workspace.id,
      desiredUrl: runtime.desiredUrl,
      desiredSha: runtime.desiredSha,
      desiredGeneration: runtime.desiredGeneration,
      defaultBranch: runtime.defaultBranch,
      ref: runtime.cloneRef || runtime.desiredSha || "HEAD",
      writeStatus: runtime.writeStatus,
      cloneToken: runtime.cloneToken,
    })
    if (!warmed.ok) return c.json({ error: warmed.error }, 503)
    await checkoutPreparedConversationBranch({
      conversationId,
      workspaceId: runtime.workspaceId ?? workspace.id,
      orgId: runtime.orgId,
      defaultBranch: runtime.defaultBranch,
      writeStatus: runtime.writeStatus,
      desiredUrl: runtime.desiredUrl,
      desiredGeneration: runtime.desiredGeneration,
      desiredSha: runtime.desiredSha,
    })
    return c.body(null, 204)
  })
  .openapi(getConversationPullRequestRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const conversation = await getConversation(conversationId)
    if (!conversation?.workspaceId) {
      return c.json({ error: "Not found" }, 404)
    }
    const workspace = await getWorkspaceById(conversation.workspaceId)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    if (conversation.lastChatPrNumber == null) {
      return c.json({ error: "Not found" }, 404)
    }
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const repoName = githubRepoFullNameFromWorkspaceUrl(
      workspace.workspaceRepositoryUrl,
    )
    if (!repoName) return c.json({ error: "Not found" }, 404)
    const state = await getPullRequestState({
      orgId: workspace.orgId,
      repositoryName: repoName,
      env,
      githubConnectionId: workspace.githubConnectionId ?? undefined,
      pullNumber: conversation.lastChatPrNumber,
    })
    if (!state) return c.json({ error: "Not found" }, 404)
    return c.json({
      branch: state.branch,
      prNumber: state.prNumber,
      pullUrl: state.pullUrl,
      prState: state.prState,
    })
  })
  .openapi(postConversationPullRequestRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const body = CreateConversationPullRequestSchema.parse(await c.req.json())
    const conversation = await getConversation(conversationId)
    if (!conversation?.workspaceId) {
      return c.json({ error: "Not found" }, 404)
    }
    const workspace = await getWorkspaceById(conversation.workspaceId)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    if (!workspaceAllowsConversationEdits(workspace.writeStatus)) {
      return c.json({ error: "read_only" }, 400)
    }
    const handle = resolveConversationSandboxHandle(conversationId)
    if (!handle) {
      return c.json({ error: "missing_sandbox" }, 409)
    }
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const repoName = githubRepoFullNameFromWorkspaceUrl(
      workspace.workspaceRepositoryUrl,
    )
    if (!repoName) {
      return c.json({ error: "not_github" }, 400)
    }
    const defaultBranch =
      (await resolveGithubDefaultBranch({
        orgId: workspace.orgId,
        githubConnectionId: workspace.githubConnectionId,
        repoFullName: repoName,
        env,
      })) ?? "main"
    const sandbox = getRegisteredChatSandbox(conversationId)
    const planned = planChatPullRequest({
      writeStatus: workspace.writeStatus,
      explicitRequest: true,
      host: "github",
      defaultBranch,
      capturedDefaultBranch: sandbox?.defaultBranch ?? defaultBranch,
      capturedGeneration:
        sandbox?.desiredGeneration ?? workspace.desiredGeneration,
      desiredGeneration: workspace.desiredGeneration,
      capturedUrl: sandbox?.desiredUrl ?? workspace.workspaceRepositoryUrl,
      desiredUrl: workspace.workspaceRepositoryUrl,
      capturedSha: sandbox?.desiredSha ?? workspace.desiredSha,
      desiredSha: workspace.desiredSha,
    })
    if (!planned.publish) {
      return c.json({ error: planned.reason }, 400)
    }
    const token = await getInstallationToken(
      workspace.orgId,
      env,
      workspace.githubConnectionId ?? undefined,
    )
    if (!token) return c.json({ error: "not_allowed" }, 400)
    const title = body.title ?? conversation.name
    const pushed = await pushConversationSessionBranch({
      handle,
      conversationId,
      defaultBranch,
      repositoryName: repoName,
      token,
      commitMessage: title,
    })
    if (!pushed.ok) return c.json({ error: pushed.error }, 400)
    if (
      conversation.lastChatPrNumber != null
    ) {
      const existing = await getPullRequestState({
        orgId: workspace.orgId,
        repositoryName: repoName,
        env,
        githubConnectionId: workspace.githubConnectionId ?? undefined,
        pullNumber: conversation.lastChatPrNumber,
      })
      if (existing?.prState === "open") {
        await persistConversationLastChatPrNumber({
          conversationId,
          lastChatPrNumber: existing.prNumber,
          lastBranch: pushed.branch,
        })
        return c.json({
          branch: pushed.branch,
          prNumber: existing.prNumber,
          pullUrl: existing.pullUrl,
          prState: existing.prState,
        })
      }
    }
    const created = await createPullRequestFromBranch({
      orgId: workspace.orgId,
      repositoryName: repoName,
      env,
      githubConnectionId: workspace.githubConnectionId ?? undefined,
      baseBranch: defaultBranch,
      branch: pushed.branch,
      title,
      body: body.body ?? "",
    })
    await persistConversationLastChatPrNumber({
      conversationId,
      lastChatPrNumber: created.pullNumber,
      lastBranch: created.branch,
    })
    return c.json({
      branch: created.branch,
      prNumber: created.pullNumber,
      pullUrl: created.pullUrl,
      prState: created.prState,
    })
  })
