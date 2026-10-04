import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { reconstructChat } from "@tanstack/ai-persistence"
import type { AppEnv } from "../../app/env.js"
import { hasOrgAdminOrOwnerRole } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import {
  type ConversationChatMessage,
  type ConversationChatRequest,
  ConversationUiMessagesTimeoutError,
  loadConversationUiMessagesBounded,
  parseConversationChatRequest,
  resolveCreatedConversationId,
  workspaceChatStreamResponse,
} from "../../domain/conversations/transport.js"
import { conversationSessionBranch } from "../../domain/workspaces/chat-lifecycle.js"
import {
  conversationPublishPreflight,
  conversationGithubTreeUrl,
  publishedSessionBranch,
  pushConversationSession,
  type SessionPublishFailure,
} from "../../domain/workspaces/conversation-publish.js"
import { sameWorkspaceBinding } from "../../domain/workspaces/revision.js"
import { withSandboxLockIfFree } from "../../domain/workspaces/sandbox-lock-store.js"
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
import {
  destroySandboxesForConversation,
  withDestroyedConversationSandboxes,
} from "../../domain/workspaces/workspace-sandbox-cleanup.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  conversationIdFromIdempotencyKey,
  generateObjectId,
} from "../../lib/id.js"
import { PageInfoSchema } from "../../lib/pagination.js"
import {
  type ConversationRecord,
  deleteConversation,
  discardUnstartedConversation,
  ensureConversation,
  getConversation,
  listConversationsPaginated,
  persistConversationPublication,
  updateConversation,
} from "../../models/conversations.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { applyAttribution } from "../../observability/attribution.js"
import { getLogger } from "../../observability/logger.js"
import {
  createPullRequestFromBranch,
  getPullRequestState,
} from "../../services/github/installation-write-client.js"
import {
  conversationFileRoutes,
  conversationPublicPrUrl,
  conversationPublicTreeUrl,
  readySandboxHandle,
  sandboxAtCapacityResponse,
} from "./conversation-files-routes.js"

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

function publicConversation(
  row: ConversationRecord,
  workspaceRepositoryUrl = "",
) {
  return ConversationSchema.parse({
    ...row,
    userId: row.userId ?? null,
    workspaceId: row.workspaceId ?? null,
    lastBranch: row.lastBranch ?? null,
    lastChatPrNumber: row.lastChatPrNumber ?? null,
    lastChatPrUrl: conversationPublicPrUrl({
      workspaceRepositoryUrl: row.lastChatPrRevision?.remote.url ?? "",
      lastChatPrNumber: row.lastChatPrNumber ?? null,
    }),
    branchTreeUrl: conversationPublicTreeUrl({
      workspaceRepositoryUrl,
      lastBranch: row.lastBranch ?? null,
    }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
  })
}

const ConversationListResponseSchema = z
  .object({
    items: z.array(ConversationSchema),
    pageInfo: PageInfoSchema,
  })
  .openapi("ConversationListResponse")

const ListConversationsQuerySchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
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
    message: IncomingMessageSchema.optional(),
    messages: z.array(z.unknown()).optional(),
    tools: z.array(z.unknown()).optional(),
    context: z.array(z.unknown()).optional(),
    state: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().optional(),
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
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Forbidden",
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
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Conversation messages timed out",
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

const postConversationsRoute = createRoute({
  method: "post",
  path: "/",
  request: {
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
    429: sandboxAtCapacityResponse,
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

const ConversationPushResponseSchema = z
  .object({ branch: z.string(), treeUrl: z.string() })
  .openapi("ConversationPushResponse")

const publishErrorResponses = {
  400: {
    content: { "application/json": { schema: ErrorResponseSchema } },
    description:
      "Not publishable: read_only, not_github, no_changes, no_write_access, rebase_in_progress, or a stale sandbox (`stale_*`)",
  },
  401: {
    content: { "application/json": { schema: ErrorResponseSchema } },
    description: "Unauthorized",
  },
  404: {
    content: { "application/json": { schema: ErrorResponseSchema } },
    description: "Not found",
  },
  429: sandboxAtCapacityResponse,
  503: {
    content: { "application/json": { schema: ErrorResponseSchema } },
    description: "Sandbox provider unavailable",
  },
  409: {
    content: { "application/json": { schema: ErrorResponseSchema } },
    description:
      "turn_running (a turn holds the conversation), missing_sandbox, session_moved (the branch has commits that do not rebase under ours) or stale_binding (the Workspace was relinked)",
  },
  502: {
    content: { "application/json": { schema: ErrorResponseSchema } },
    description: "GitHub refused or failed the push or the pull request",
  },
} as const

const postConversationPushRoute = createRoute({
  method: "post",
  path: "/{conversationId}/push",
  request: { params: ConversationParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConversationPushResponseSchema },
      },
      description: "Committed and pushed the session branch",
    },
    ...publishErrorResponses,
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
    ...publishErrorResponses,
  },
})

type PullRequestOutcome =
  | {
      pullRequest: {
        branch: string
        prNumber: number
        pullUrl: string
        prState: "open" | "closed" | "merged"
      }
    }
  | { status: 400 | 409 | 429 | 502 | 503; error: string }

function skippedOutcome(
  reason: string,
): Extract<PullRequestOutcome, { error: string }> {
  return { status: reason === "stale_binding" ? 409 : 400, error: reason }
}

function publishFailure(
  reason: SessionPublishFailure,
): Extract<PullRequestOutcome, { error: string }> {
  if (reason === "session_moved") return { status: 409, error: reason }
  if (reason === "no_write_access") return { status: 400, error: reason }
  return { status: 502, error: reason }
}

/**
 * Create PR, under the conversation's lock: push the commits a live sandbox
 * still holds, then open (or reuse) the pull request from the session branch
 * as it is. Without a live sandbox the branch on GitHub is used.
 */
async function createConversationPullRequest(input: {
  conversation: NonNullable<Awaited<ReturnType<typeof getConversation>>>
  workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceById>>>
  title: string
  body: string
}): Promise<PullRequestOutcome> {
  const { conversation, workspace, title } = input
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const target = {
    conversationId: conversation.id,
    orgId: workspace.orgId,
    workspaceId: workspace.id,
    env,
  }
  const preflight = await conversationPublishPreflight(target)
  if (!preflight.ok) return skippedOutcome(preflight.reason)
  const { revision } = preflight
  const ready = await readySandboxHandle({
    conversation,
    workspace,
    existingOnly: true,
    transcriptLocked: true,
  })
  if (!ready.ok && ready.error !== "missing_sandbox")
    return { status: ready.status, error: ready.error }
  // Commits the agent made but did not push go with the PR; uncommitted
  // files do not (that is Commit+Push).
  if (ready.ok) {
    const pushed = await pushConversationSession({
      ...target,
      handle: ready.handle,
    })
    if (pushed.status === "skipped" && pushed.reason !== "nothing_committed")
      return skippedOutcome(pushed.reason)
    if (pushed.status === "failed") return publishFailure(pushed.reason)
  }
  const published = await publishedSessionBranch({
    ...target,
    expected: revision,
  })
  if (published.status === "skipped") return skippedOutcome(published.reason)
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  if (!repositoryName) return { status: 400, error: "not_github" }
  const github = {
    orgId: workspace.orgId,
    repositoryName,
    env,
    githubConnectionId: revision.remote.connectionId ?? undefined,
  }
  try {
    if (
      conversation.lastChatPrNumber != null &&
      sameWorkspaceBinding(conversation.lastChatPrRevision, revision)
    ) {
      const existing = await getPullRequestState({
        ...github,
        pullNumber: conversation.lastChatPrNumber,
      })
      if (
        existing?.prState === "open" &&
        existing.branch === published.branch
      ) {
        if (
          !(await persistConversationPublication({
            conversationId: conversation.id,
            lastChatPrNumber: existing.prNumber,
            lastBranch: published.branch,
            revision,
          }))
        )
          return { status: 409, error: "stale_binding" }
        return {
          pullRequest: {
            branch: published.branch,
            prNumber: existing.prNumber,
            pullUrl: existing.pullUrl,
            prState: existing.prState,
          },
        }
      }
    }
    const created = await createPullRequestFromBranch({
      ...github,
      revision,
      baseBranch: revision.defaultBranch,
      branch: published.branch,
      title,
      body: input.body,
    })
    if (!created) return { status: 409, error: "stale_binding" }
    if (
      !(await persistConversationPublication({
        conversationId: conversation.id,
        lastChatPrNumber: created.pullNumber,
        lastBranch: created.branch,
        revision,
      }))
    )
      return { status: 409, error: "stale_binding" }
    return {
      pullRequest: {
        branch: created.branch,
        prNumber: created.pullNumber,
        pullUrl: created.pullUrl,
        prState: created.prState,
      },
    }
  } catch (error) {
    getLogger().error(
      error instanceof Error ? error : new Error(String(error)),
      {
        step: "conversation-pull-request",
      },
    )
    return { status: 502, error: "github_unavailable" }
  }
}

/**
 * Commit+Push, under the conversation's lock: commit the sandbox's
 * uncommitted files and push the session branch through the broker.
 */
async function pushConversationBranch(input: {
  conversation: NonNullable<Awaited<ReturnType<typeof getConversation>>>
  workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceById>>>
}): Promise<
  | { pushed: { branch: string; treeUrl: string } }
  | { status: 400 | 409 | 429 | 502 | 503; error: string }
> {
  const { conversation, workspace } = input
  const ready = await readySandboxHandle({
    conversation,
    workspace,
    existingOnly: true,
    transcriptLocked: true,
  })
  if (!ready.ok) return { status: ready.status, error: ready.error }
  const pushed = await pushConversationSession({
    handle: ready.handle,
    conversationId: conversation.id,
    orgId: workspace.orgId,
    workspaceId: workspace.id,
    env: parseEnv(process.env as Record<string, string | undefined>),
    commit: { subject: conversation.name },
  })
  if (pushed.status === "unchanged") return { status: 400, error: "no_changes" }
  if (pushed.status === "skipped") return skippedOutcome(pushed.reason)
  if (pushed.status === "failed") return publishFailure(pushed.reason)
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(
    workspace.workspaceRepositoryUrl,
  )
  return {
    pushed: {
      branch: pushed.branch,
      treeUrl: repositoryName
        ? conversationGithubTreeUrl({ repositoryName, branch: pushed.branch })
        : "",
    },
  }
}

async function getReadableConversation(
  conversationId: string,
  input: { workspaceId?: string; orgId?: string | null; headers: Headers },
) {
  const conversation = await getConversation(conversationId, {
    workspaceId: input.workspaceId,
  })
  if (conversation) return conversation
  if (
    !input.orgId ||
    !(await hasOrgAdminOrOwnerRole({
      headers: input.headers,
      orgId: input.orgId,
    }))
  ) {
    return null
  }
  return getConversation(conversationId, {
    workspaceId: input.workspaceId,
    orgService: true,
  })
}

function withConversationIdHeader(response: Response, conversationId: string) {
  const headers = new Headers(response.headers)
  headers.set("x-conversation-id", conversationId)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function workspaceConversationStream(
  conversationId: string,
  parsed: ConversationChatRequest,
  request: Request,
  orgSlug: string | null | undefined,
  orgId: string | null | undefined,
) {
  return withConversationIdHeader(
    workspaceChatStreamResponse(
      {
        conversationId,
        checkpointNamespace: "",
        prompt: parsed.prompt,
        messages: parsed.messages,
        threadId: parsed.threadId ?? conversationId,
        runId: parsed.runId,
        source: parsed.source ?? null,
        workspaceId: parsed.workspaceId,
        orgId,
        orgSlug,
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
      request,
    ),
    conversationId,
  )
}

export const conversationRoutes = new OpenAPIHono<AppEnv>()
  .route("/", conversationFileRoutes)
  .openapi(listConversationsRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const query = ListConversationsQuerySchema.parse({
      workspaceId: c.req.query("workspaceId"),
      source: c.req.query("source"),
      first: c.req.query("first"),
      after: c.req.query("after"),
    })
    const orgId = c.get("orgId")
    if (query.source === "mcp-service") {
      if (
        !orgId ||
        !(await hasOrgAdminOrOwnerRole({
          headers: c.req.raw.headers,
          orgId,
        }))
      ) {
        return c.json({ error: "Forbidden" }, 403)
      }
      const { items: rows, pageInfo } = await listConversationsPaginated({
        orgService: true,
        workspaceId: query.workspaceId?.trim() || undefined,
        first: query.first,
        after: query.after,
      })
      const listedWorkspace = query.workspaceId?.trim()
        ? await getWorkspaceById(query.workspaceId.trim())
        : null
      const items = rows.map((row) =>
        publicConversation(row, listedWorkspace?.workspaceRepositoryUrl),
      )
      return c.json({ items, pageInfo }, 200)
    }
    if (query.source === "mcp") {
      const { items: rows, pageInfo } = await listConversationsPaginated({
        source: "mcp",
        orgService: false,
        workspaceId: query.workspaceId?.trim() || undefined,
        first: query.first,
        after: query.after,
      })
      const listedWorkspace = query.workspaceId?.trim()
        ? await getWorkspaceById(query.workspaceId.trim())
        : null
      const items = rows.map((row) =>
        publicConversation(row, listedWorkspace?.workspaceRepositoryUrl),
      )
      return c.json({ items, pageInfo }, 200)
    }
    if (!query.workspaceId?.trim()) {
      return c.json({ error: "workspace_required" }, 400)
    }
    const { items: rows, pageInfo } = await listConversationsPaginated({
      source: "ui",
      workspaceId: query.workspaceId.trim(),
      first: query.first,
      after: query.after,
    })
    const listedWorkspace = await getWorkspaceById(query.workspaceId.trim())

    const items = rows.map((row) =>
      publicConversation(row, listedWorkspace?.workspaceRepositoryUrl),
    )
    return c.json({ items, pageInfo }, 200)
  })
  .openapi(getConversationRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const workspaceId = c.req.query("workspaceId")
    const conversation = await getReadableConversation(conversationId, {
      workspaceId,
      orgId: c.get("orgId"),
      headers: c.req.raw.headers,
    })
    if (!conversation) return c.json({ error: "Not found" }, 404)
    applyAttribution({ "ctxpipe.conversation.id": conversation.id })

    let messages: ConversationChatMessage[]
    try {
      messages = await loadConversationUiMessagesBounded({
        conversationId,
        checkpointNamespace: "",
        workspaceId: conversation.workspaceId,
      })
    } catch (error) {
      if (error instanceof ConversationUiMessagesTimeoutError) {
        getLogger().error(error, {
          step: "conversation.get.messages",
          conversationId,
        })
        return c.json({ error: "Conversation messages unavailable" }, 503)
      }
      throw error
    }
    const detailWorkspace = conversation.workspaceId
      ? await getWorkspaceById(conversation.workspaceId)
      : null

    return c.json(
      {
        conversation: publicConversation(
          conversation,
          detailWorkspace?.workspaceRepositoryUrl,
        ),
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
    const conversation = await getReadableConversation(conversationId, {
      workspaceId,
      orgId: c.get("orgId"),
      headers: c.req.raw.headers,
    })
    if (!conversation) return c.json({ error: "Not found" }, 404)
    applyAttribution({ "ctxpipe.conversation.id": conversation.id })

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

    return c.json(publicConversation(updated), 200)
  })
  .openapi(deleteConversationRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    const existing = await getConversation(conversationId)
    if (!existing) return c.json({ error: "Not found" }, 404)
    const log = getLogger()
    log.set({
      conversationId,
      workspaceId: existing.workspaceId ?? null,
      sandbox: "chat",
    })
    log.info("destroy chat sandbox after conversation delete")
    const deleted = existing.workspaceId
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
    if (!existing.workspaceId) {
      await destroySandboxesForConversation(conversationId)
    }

    return c.body(null, 204)
  })
  .openapi(postConversationsRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const raw = await c.req.json()
    let parsed: ConversationChatRequest
    try {
      parsed = await parseConversationChatRequest(raw)
    } catch {
      return c.json({ error: "Message text is required" }, 400)
    }
    if (parsed.prompt.length === 0) {
      return c.json({ error: "Message text is required" }, 400)
    }
    if (!parsed.workspaceId.trim()) {
      return c.json({ error: "workspace_required" }, 400)
    }

    const idempotencyKey =
      c.req.header("Idempotency-Key")?.trim() ||
      (raw &&
      typeof raw === "object" &&
      "idempotencyKey" in raw &&
      typeof raw.idempotencyKey === "string"
        ? raw.idempotencyKey.trim()
        : "")
    const conversationId = resolveCreatedConversationId({
      conversationId: parsed.conversationId,
      idempotencyKey,
      userId: c.get("user")?.id ?? "",
      workspaceId: parsed.workspaceId,
      generateId: () => generateObjectId("conv"),
      idFromIdempotencyKey: conversationIdFromIdempotencyKey,
    })
    applyAttribution({ "ctxpipe.conversation.id": conversationId })
    if (idempotencyKey && (await conversationHasStoredTurns(conversationId))) {
      return withConversationIdHeader(
        new Response("", { status: 200 }),
        conversationId,
      )
    }
    return workspaceConversationStream(
      conversationId,
      parsed,
      c.req.raw,
      c.get("orgSlug"),
      c.get("orgId"),
    )
  })
  .openapi(postConversationMessageRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    applyAttribution({ "ctxpipe.conversation.id": conversationId })
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

    return workspaceConversationStream(
      conversationId,
      parsed,
      c.req.raw,
      c.get("orgSlug"),
      c.get("orgId"),
    )
  })
  .openapi(postConversationPrepareRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)

    const conversationId = c.req.param("conversationId")
    applyAttribution({ "ctxpipe.conversation.id": conversationId })
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
      lastBranch: runtime.lastBranch,
      ref: runtime.cloneRef || runtime.desiredSha || "HEAD",
      writeStatus: runtime.writeStatus,
      cloneToken: runtime.cloneToken,
      githubConnectionId: runtime.githubConnectionId,
    })
    if (!warmed.ok)
      return warmed.status === 429
        ? c.json({ error: warmed.error }, 429)
        : c.json({ error: warmed.error }, 503)
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
    const revision = conversation.lastChatPrRevision
    if (!revision || conversation.lastChatPrNumber == null)
      return c.json({ error: "Not found" }, 404)
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const repoName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
    if (!repoName) return c.json({ error: "Not found" }, 404)
    const state = await getPullRequestState({
      orgId: conversation.orgId,
      repositoryName: repoName,
      env,
      githubConnectionId: revision.remote.connectionId ?? undefined,
      pullNumber: conversation.lastChatPrNumber,
    })
    const current = await getConversation(conversationId)
    if (
      !state ||
      state.branch !==
        conversationSessionBranch(conversationId, conversation.lastBranch) ||
      current?.lastChatPrNumber !== conversation.lastChatPrNumber ||
      !sameWorkspaceBinding(current?.lastChatPrRevision, revision)
    )
      return c.json({ error: "Not found" }, 404)
    return c.json(
      {
        branch: state.branch,
        prNumber: state.prNumber,
        pullUrl: state.pullUrl,
        prState: state.prState,
      },
      200,
    )
  })
  .openapi(postConversationPushRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const conversation = await getConversation(conversationId)
    if (!conversation?.workspaceId) return c.json({ error: "Not found" }, 404)
    const workspace = await getWorkspaceById(conversation.workspaceId)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    // A running turn holds the conversation; the agent can push from it.
    const locked = await withSandboxLockIfFree(
      conversation.orgId,
      `chat-thread:${conversationId}`,
      () => pushConversationBranch({ conversation, workspace }),
    )
    if (locked.busy) return c.json({ error: "turn_running" }, 409)
    const outcome = locked.value
    if ("error" in outcome)
      return c.json({ error: outcome.error }, outcome.status)
    return c.json(outcome.pushed, 200)
  })
  .openapi(postConversationPullRequestRoute, async (c) => {
    const user = c.get("user")
    const session = c.get("session")
    if (!user || !session) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const body = CreateConversationPullRequestSchema.parse(await c.req.json())
    const conversation = await getConversation(conversationId)
    if (!conversation?.workspaceId) return c.json({ error: "Not found" }, 404)
    const workspace = await getWorkspaceById(conversation.workspaceId)
    if (!workspace) return c.json({ error: "Not found" }, 404)
    // A running turn holds the conversation and pushes when it ends.
    const locked = await withSandboxLockIfFree(
      conversation.orgId,
      `chat-thread:${conversationId}`,
      () =>
        createConversationPullRequest({
          conversation,
          workspace,
          title: body.title ?? conversation.name,
          body: body.body ?? "",
        }),
    )
    if (locked.busy) return c.json({ error: "turn_running" }, 409)
    const outcome = locked.value
    if ("error" in outcome)
      return c.json({ error: outcome.error }, outcome.status)
    return c.json(outcome.pullRequest, 200)
  })
