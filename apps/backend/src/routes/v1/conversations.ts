import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { filterInternalNodeMessageChunks } from "../../domain/conversations/internalNodeMessageFilter.js"
import { createRenameStreamEnhancer } from "../../domain/conversations/renameStream.js"
import {
  createDataStreamConversationTransport,
  loadConversationUiMessages,
  toPromptFromIncomingMessage,
} from "../../domain/conversations/transport.js"
import {
  applyQuietChatUpdate,
  chatSessionBranchName,
  lastBranchExistsOnRemote,
  mayForcePushBranch,
  planChatPullRequest,
  quietUpdateChatBranch,
  restoreBranchAfterIdle,
  shouldDestroyChatSandbox,
  treeDirtyFromPorcelain,
} from "../../domain/workspaces/chat-lifecycle.js"
import {
  checkoutPublishedChatBranch,
  collectChatPullRequestTree,
} from "../../domain/workspaces/chat-pull-request.js"
import {
  destroySandboxesForConversation,
  getChatSandbox,
  getRegisteredChatSandbox,
} from "../../domain/workspaces/sandbox-registry.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { PageInfoSchema } from "../../lib/pagination.js"
import {
  deleteConversation,
  discardUnstartedConversation,
  ensureConversation,
  getConversation,
  listConversationsPaginated,
  persistConversationLastBranch,
  reserveConversationChatPrNumber,
  touchConversationLastMessage,
  updateConversation,
} from "../../models/conversations.js"
import { getInstallationToken } from "../../models/github-installation.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import {
  createPullRequestWithFiles,
  githubRefExists,
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
    workspaceId: z.string().optional(),
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
    workspaceId: z.string().optional(),
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
    500: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Failed to start the conversation stream",
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
  })
  .openapi("ConversationPullRequestResponse")

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
  .openapi(listConversationsRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const query = ListConversationsQuerySchema.parse({
      source: c.req.query("source"),
      workspaceId: c.req.query("workspaceId"),
      first: c.req.query("first"),
      after: c.req.query("after"),
    })

    const { items: rows, pageInfo } = await listConversationsPaginated({
      source: query.source === "all" ? undefined : (query.source ?? "ui"),
      workspaceId: query.workspaceId,
      first: query.first,
      after: query.after,
    })

    const items = rows.map((row) => ({
      ...row,
      userId: row.userId ?? null,
      workspaceId: row.workspaceId ?? null,
      lastBranch: row.lastBranch ?? null,
      lastChatPrNumber: row.lastChatPrNumber ?? null,
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

    return c.json(
      {
        conversation: {
          ...conversation,
          userId: conversation.userId ?? null,
          workspaceId: conversation.workspaceId ?? null,
          lastBranch: conversation.lastBranch ?? null,
          lastChatPrNumber: conversation.lastChatPrNumber ?? null,
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
    const deleted = await deleteConversation(conversationId)
    if (!deleted) return c.json({ error: "Not found" }, 404)
    if (
      shouldDestroyChatSandbox({
        conversationDeleted: true,
        lastTurnAt: existing?.lastMessageAt ?? null,
        now: new Date(),
      })
    ) {
      const log = getLogger()
      log.set({
        conversationId,
        workspaceId: existing?.workspaceId ?? null,
        sandbox: "chat",
      })
      log.info("destroy chat sandbox after conversation delete")
      await destroySandboxesForConversation(conversationId)
    }

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

    const conversation = await ensureConversation({
      id: conversationId,
      source: body.source,
      workspaceId: body.workspaceId,
    })
    const workspace = conversation.workspaceId
      ? await getWorkspaceById(conversation.workspaceId)
      : null
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const repoName = workspace
      ? githubRepoFullNameFromWorkspaceUrl(workspace.workspaceRepositoryUrl)
      : null
    const defaultBranch =
      workspace && repoName
        ? ((await resolveGithubDefaultBranch({
            orgId: workspace.orgId,
            githubConnectionId: workspace.githubConnectionId,
            repoFullName: repoName,
            env,
          })) ?? "main")
        : "main"
    let remoteHasLastBranch = false
    if (conversation.lastBranch && workspace && repoName) {
      try {
        remoteHasLastBranch = await githubRefExists({
          orgId: workspace.orgId,
          repositoryName: repoName,
          env,
          githubConnectionId: workspace.githubConnectionId ?? undefined,
          ref: conversation.lastBranch,
        })
      } catch {
        remoteHasLastBranch = false
      }
    }
    const lastBranch = restoreBranchAfterIdle({
      lastBranch: conversation.lastBranch,
      lastBranchExistsOnRemote: lastBranchExistsOnRemote({
        lastBranch: conversation.lastBranch,
        remoteBranches:
          remoteHasLastBranch && conversation.lastBranch
            ? [conversation.lastBranch]
            : [],
      }),
      defaultBranch,
    })
    if (lastBranch.startsWith("ctxpipe/chat/")) {
      await persistConversationLastBranch({
        conversationId,
        lastBranch,
      })
    }
    const chatSandbox = getChatSandbox(conversationId)
    if (chatSandbox && workspace?.desiredSha) {
      const status = await chatSandbox.exec("git status --porcelain", {
        env: {},
      })
      const tipPresent = await chatSandbox.exec(
        `git cat-file -t ${workspace.desiredSha}`,
        { env: {} },
      )
      const treeDirty = treeDirtyFromPorcelain(status.stdout)
      await applyQuietChatUpdate({
        decision: quietUpdateChatBranch({
          lastBranch,
          defaultBranch,
          lastBranchPublished:
            remoteHasLastBranch && lastBranch.startsWith("ctxpipe/chat/"),
          treeDirty,
          rebaseApplies: tipPresent.exitCode === 0 && treeDirty,
        }),
        desiredSha: workspace.desiredSha,
        exec: chatSandbox.exec,
      }).catch(() => undefined)
    }

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

    try {
      const response = await transport.toResponse({
        conversationId,
        checkpointNamespace: "",
        prompt,
        source: body.source ?? null,
        writeStatus: workspace?.writeStatus ?? "read_only",
        lastBranch,
        workspaceId: conversation.workspaceId,
        orgId: workspace?.orgId ?? conversation.orgId,
        desiredUrl: workspace?.workspaceRepositoryUrl ?? null,
        desiredSha: workspace?.desiredSha ?? null,
        desiredGeneration: workspace?.desiredGeneration,
        defaultBranch,
        cloneToken: workspace
          ? ((await getInstallationToken(
              workspace.orgId,
              env,
              workspace.githubConnectionId ?? undefined,
            )) ?? null)
          : null,
        onHeartbeat: () => touchConversationLastMessage(conversationId),
        onFinish: () => touchConversationLastMessage(conversationId),
        streamEnhancers: [internalFilterEnhancer, renameEnhancer],
      })
      await touchConversationLastMessage(conversationId)
      return response
    } catch {
      await discardUnstartedConversation(conversationId)
      return c.json({ error: "Failed to start conversation" }, 500)
    }
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
    const sandbox = getRegisteredChatSandbox(conversationId)
    if (!sandbox?.handle) {
      return c.json({ error: "missing_sandbox" }, 409)
    }
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const repoName = githubRepoFullNameFromWorkspaceUrl(
      workspace.workspaceRepositoryUrl,
    )
    const defaultBranch = repoName
      ? ((await resolveGithubDefaultBranch({
          orgId: workspace.orgId,
          githubConnectionId: workspace.githubConnectionId,
          repoFullName: repoName,
          env,
        })) ?? "main")
      : "main"
    const planned = planChatPullRequest({
      writeStatus: workspace.writeStatus,
      explicitRequest: true,
      host: repoName ? "github" : "other",
      defaultBranch,
      capturedDefaultBranch: sandbox.defaultBranch ?? null,
      capturedGeneration: sandbox.desiredGeneration ?? null,
      desiredGeneration: workspace.desiredGeneration,
      capturedUrl: sandbox.desiredUrl ?? null,
      desiredUrl: workspace.workspaceRepositoryUrl,
      capturedSha: sandbox.desiredSha ?? null,
      desiredSha: workspace.desiredSha,
    })
    if (!planned.publish) {
      return c.json({ error: planned.reason }, 400)
    }
    if (!repoName) {
      return c.json({ error: "not_github" }, 400)
    }
    const tree = await collectChatPullRequestTree(sandbox.handle)
    if (tree.files.length === 0 && tree.deletePaths.length === 0) {
      return c.json({ error: "no_changes" }, 400)
    }
    const latest = await getWorkspaceById(conversation.workspaceId)
    if (!latest) return c.json({ error: "Not found" }, 404)
    const stillFresh = planChatPullRequest({
      writeStatus: latest.writeStatus,
      explicitRequest: true,
      host: repoName ? "github" : "other",
      defaultBranch,
      capturedDefaultBranch: sandbox.defaultBranch ?? null,
      capturedGeneration: sandbox.desiredGeneration ?? null,
      desiredGeneration: latest.desiredGeneration,
      capturedUrl: sandbox.desiredUrl ?? null,
      desiredUrl: latest.workspaceRepositoryUrl,
      capturedSha: sandbox.desiredSha ?? null,
      desiredSha: latest.desiredSha,
    })
    if (!stillFresh.publish) {
      return c.json({ error: stillFresh.reason }, 400)
    }
    const prNumber = await reserveConversationChatPrNumber(conversationId)
    const branch = chatSessionBranchName(conversationId, prNumber)
    if (!mayForcePushBranch(branch, defaultBranch)) {
      return c.json({ error: "default_branch" }, 400)
    }
    const created = await createPullRequestWithFiles({
      orgId: latest.orgId,
      repositoryName: repoName,
      env,
      githubConnectionId: latest.githubConnectionId ?? undefined,
      baseBranch: defaultBranch,
      branch,
      title: body.title ?? `Workspace chat ${conversationId}`,
      body: body.body ?? "",
      commitMessage: body.title ?? `Workspace chat ${conversationId}`,
      files: tree.files,
      deletePaths: tree.deletePaths,
      requireNewBranch: true,
    })
    await persistConversationLastBranch({
      conversationId,
      lastBranch: created.branch,
    })
    try {
      await checkoutPublishedChatBranch({
        handle: sandbox.handle,
        branch: created.branch,
      })
    } catch (error) {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "checkout-published-chat-branch", conversationId },
      )
    }
    return c.json(
      {
        branch: created.branch,
        prNumber: created.pullNumber,
        pullUrl: created.pullUrl,
      },
      200,
    )
  })
