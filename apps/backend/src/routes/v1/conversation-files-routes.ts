import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { createMiddleware } from "hono/factory"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import { conversationSessionBranch as sessionBranchName } from "../../domain/workspaces/chat-lifecycle.js"
import { workspaceAllowsConversationEdits } from "../../domain/workspaces/chat-sandbox-policy.js"
import {
  conversationSandboxDiff,
  conversationSandboxStatus,
  conversationWorktreeVersion,
  getConversationSandboxBinding,
  listConversationSandboxPaths,
  readConversationSandboxFile,
  removeConversationSandboxPath,
  renameConversationSandboxPath,
  writeConversationSandboxFile,
} from "../../domain/workspaces/conversation-files.js"
import {
  conversationGithubPullUrl,
  conversationGithubTreeUrl,
  planCapturedConversationPublication,
  pushConversationSessionBranch,
} from "../../domain/workspaces/conversation-publish.js"
import { adaptTanstackHandle } from "../../domain/workspaces/job-sandbox.js"
import type { JobSandboxHandle } from "../../domain/workspaces/job-worktree.js"
import { postgresSandboxLocks } from "../../domain/workspaces/sandbox-lock-store.js"
import { warmTanstackWorkspaceChat } from "../../domain/workspaces/tanstack-workspace-chat.js"
import { resolveWorkspaceChatTurnRuntime } from "../../domain/workspaces/workspace-chat-turn-runtime.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  getConversation,
  persistConversationPublication,
} from "../../models/conversations.js"
import {
  getDesiredWorkspaceRevision,
  getWorkspaceById,
} from "../../models/workspaces.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ConversationFileErrorResponse")

const ConversationParamsSchema = z
  .object({
    conversationId: z.string().min(1),
  })
  .openapi("ConversationFileParams")

const ConversationGitTreeResponseSchema = z
  .object({
    sha: z.string(),
    paths: z.array(z.string()),
    branch: z.string(),
    worktreeVersion: z.string(),
  })
  .openapi("ConversationGitTreeResponse")

const ConversationGitBlobQuerySchema = z
  .object({
    path: z.string().min(1),
  })
  .openapi("ConversationGitBlobQuery")

const ConversationGitBlobResponseSchema = z
  .object({
    path: z.string(),
    body: z.string().nullable(),
    binary: z.boolean(),
  })
  .openapi("ConversationGitBlobResponse")

const ConversationGitStatusResponseSchema = z
  .object({
    source: z.literal("sandbox"),
    branch: z.string().min(1),
    sha: z.string().nullable(),
    desiredSha: z.string().nullable(),
    stale: z.boolean(),
    dirty: z.boolean(),
    differsFromDefault: z.boolean(),
    unpushed: z.boolean(),
    published: z.boolean(),
    ahead: z.number().int(),
    behind: z.number().int(),
    items: z.array(
      z.object({
        path: z.string(),
        status: z.string(),
        additions: z.number().int().optional(),
        deletions: z.number().int().optional(),
      }),
    ),
    worktreeVersion: z.string(),
  })
  .openapi("ConversationGitStatusResponse")

const ConversationGitDiffResponseSchema = z
  .object({
    items: z.array(
      z.object({
        path: z.string(),
        oldBody: z.string().nullable(),
        body: z.string().nullable(),
      }),
    ),
  })
  .openapi("ConversationGitDiffResponse")

const PutConversationFileBodySchema = z
  .object({
    path: z.string().min(1),
    body: z.string().optional(),
    deletePath: z.boolean().optional(),
    from: z.string().min(1).optional(),
    expectedWorktreeVersion: z.string().min(1).optional(),
  })
  .openapi("PutConversationFileBody")

const ConversationFileWriteResponseSchema = z
  .object({
    path: z.string(),
    body: z.string().nullable(),
    binary: z.boolean(),
    worktreeVersion: z.string(),
    tree: ConversationGitTreeResponseSchema,
    status: ConversationGitStatusResponseSchema,
  })
  .openapi("ConversationFileWriteResponse")

const ConversationFileConflictSchema = z
  .object({
    error: z.string(),
    worktreeVersion: z.string().optional(),
  })
  .openapi("ConversationFileConflictResponse")

const ConversationPushResponseSchema = z
  .object({
    branch: z.string(),
    treeUrl: z.string(),
  })
  .openapi("ConversationPushResponse")

const listTreeRoute = createRoute({
  method: "get",
  path: "/{conversationId}/files/tree",
  request: {
    params: ConversationParamsSchema,
  },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Workspace configuration invalid",
    },
    200: {
      content: {
        "application/json": { schema: ConversationGitTreeResponseSchema },
      },
      description: "Sandbox git tree",
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
      description: "Sandbox provider unavailable",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Chat sandbox missing",
    },
  },
})

const getBlobRoute = createRoute({
  method: "get",
  path: "/{conversationId}/files/blob",
  request: {
    params: ConversationParamsSchema,
    query: ConversationGitBlobQuerySchema,
  },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Workspace configuration invalid",
    },
    200: {
      content: {
        "application/json": { schema: ConversationGitBlobResponseSchema },
      },
      description: "Sandbox file",
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
      description: "Sandbox provider unavailable",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Chat sandbox missing",
    },
  },
})

const getStatusRoute = createRoute({
  method: "get",
  path: "/{conversationId}/files/status",
  request: {
    params: ConversationParamsSchema,
  },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Workspace configuration invalid",
    },
    200: {
      content: {
        "application/json": { schema: ConversationGitStatusResponseSchema },
      },
      description: "Sandbox git status vs default",
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
      description: "Sandbox provider unavailable",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Chat sandbox missing",
    },
  },
})

const getDiffRoute = createRoute({
  method: "get",
  path: "/{conversationId}/files/diff",
  request: { params: ConversationParamsSchema },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Workspace configuration invalid",
    },
    200: {
      content: {
        "application/json": { schema: ConversationGitDiffResponseSchema },
      },
      description: "Per-file diffs vs default",
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
      description: "Sandbox provider unavailable",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Chat sandbox missing",
    },
  },
})

const putFileRoute = createRoute({
  method: "put",
  path: "/{conversationId}/files/blob",
  request: {
    params: ConversationParamsSchema,
    body: {
      content: {
        "application/json": { schema: PutConversationFileBodySchema },
      },
    },
  },
  responses: {
    400: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Workspace configuration invalid",
    },
    200: {
      content: {
        "application/json": { schema: ConversationFileWriteResponseSchema },
      },
      description: "Wrote sandbox file",
    },
    401: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Unauthorized",
    },
    403: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Read-only",
    },
    404: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Not found",
    },
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Sandbox provider unavailable",
    },
    409: {
      content: {
        "application/json": { schema: ConversationFileConflictSchema },
      },
      description: "Chat sandbox missing or stale worktree",
    },
  },
})

const postPushRoute = createRoute({
  method: "post",
  path: "/{conversationId}/push",
  request: { params: ConversationParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConversationPushResponseSchema },
      },
      description: "Pushed the session branch",
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
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Sandbox provider unavailable",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Chat sandbox missing",
    },
  },
})

async function loadConversationWorkspace(
  conversationId: string,
  abortSignal?: AbortSignal,
) {
  const conversation = await getConversation(conversationId)
  if (!conversation?.workspaceId) return null
  const workspace = await getWorkspaceById(conversation.workspaceId)
  if (!workspace) return null
  return { conversation, workspace, transcriptLocked: true, abortSignal }
}

function requireUser(c: { get: (key: "user" | "session") => unknown }) {
  return Boolean(c.get("user") && c.get("session"))
}

type ConversationSandboxAttachInput = {
  abortSignal?: AbortSignal
  transcriptLocked?: boolean
  existingOnly?: boolean
  conversation: {
    id: string
    orgId: string
    workspaceId: string | null
    lastBranch: string | null
  }
  workspace: {
    id: string
    orgId: string
    workspaceRepositoryUrl: string
    githubConnectionId?: string | null
    writeStatus: string
    readOnlyReason?: string | null
    desiredSha: string | null
    desiredDefaultBranch?: string | null
    desiredGeneration?: number
  }
}

export async function readySandboxHandle(
  input: ConversationSandboxAttachInput,
) {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const runtime = await resolveWorkspaceChatTurnRuntime({
    conversation: input.conversation,
    workspace: input.workspace,
    env,
  })
  if (!runtime.desiredUrl)
    return {
      ok: false as const,
      status: 400 as const,
      error: "workspace_required",
    }
  const warmed = await warmTanstackWorkspaceChat(
    {
      conversationId: input.conversation.id,
      abortSignal: input.abortSignal,
      prompt: "prepare",
      orgId: runtime.orgId,
      workspaceId: runtime.workspaceId ?? input.workspace.id,
      desiredUrl: runtime.desiredUrl,
      desiredSha: runtime.desiredSha,
      desiredGeneration: runtime.desiredGeneration,
      defaultBranch: runtime.defaultBranch,
      lastBranch: runtime.lastBranch,
      ref: runtime.cloneRef || runtime.desiredSha || "HEAD",
      writeStatus: runtime.writeStatus,
      cloneToken: runtime.cloneToken,
      githubConnectionId: runtime.githubConnectionId,
    },
    {
      existingOnly: input.existingOnly,
      transcriptLocked: input.transcriptLocked,
    },
  )
  if (!warmed.ok) return warmed
  return {
    ok: true as const,
    handle: adaptTanstackHandle(warmed.handle, input.abortSignal),
  }
}

async function conversationFileSnapshot(input: {
  handle: JobSandboxHandle
  conversationId: string
  workspace: { id: string; desiredDefaultBranch?: string | null }
}) {
  const defaultBranch = input.workspace.desiredDefaultBranch?.trim() || "main"
  const [paths, branchResult, status, worktreeVersion, revision] =
    await Promise.all([
      listConversationSandboxPaths(input.handle),
      input.handle.exec("git branch --show-current"),
      conversationSandboxStatus({
        handle: input.handle,
        defaultBranch,
        sessionBranch: sessionBranchName(input.conversationId),
      }),
      conversationWorktreeVersion(input.handle),
      getDesiredWorkspaceRevision(input.workspace.id),
    ])
  if (branchResult.exitCode !== 0) {
    throw new Error("Conversation branch is unavailable")
  }
  const branch = branchResult.stdout.trim()
  const binding = revision
    ? await getConversationSandboxBinding(input.conversationId, revision)
    : null
  return {
    worktreeVersion,
    tree: {
      sha: binding?.desiredSha ?? "HEAD",
      paths,
      branch,
      worktreeVersion,
    },
    status: {
      source: "sandbox" as const,
      ...status,
      sha: binding?.desiredSha ?? null,
      desiredSha: revision?.sha ?? null,
      stale: binding?.desiredSha !== revision?.sha,
      worktreeVersion,
    },
  }
}

type ConversationFileEnv = AppEnv & {
  Variables: { sandboxAbortSignal: AbortSignal }
}
const withConversationFileLock = createMiddleware<ConversationFileEnv>(
  async (c, next) => {
    if (!requireUser(c)) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const loaded = conversationId
      ? await loadConversationWorkspace(conversationId)
      : null
    if (!loaded) return c.json({ error: "Not found" }, 404)
    const controller = new AbortController()
    const onRequestAbort = () => controller.abort(c.req.raw.signal.reason)
    c.req.raw.signal.addEventListener("abort", onRequestAbort, { once: true })
    if (c.req.raw.signal.aborted) onRequestAbort()
    c.set("sandboxAbortSignal", controller.signal)
    try {
      return await postgresSandboxLocks(
        loaded.conversation.orgId,
        controller,
      ).withLock(`chat-thread:${conversationId}`, () => next())
    } finally {
      c.req.raw.signal.removeEventListener("abort", onRequestAbort)
    }
  },
)
const fileRoutes = new OpenAPIHono<ConversationFileEnv>()
fileRoutes.use("/:conversationId/files/*", withConversationFileLock)
fileRoutes.use("/:conversationId/push", withConversationFileLock)
export const conversationFileRoutes = fileRoutes
  .openapi(listTreeRoute, async (c) => {
    if (!requireUser(c)) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const loaded = await loadConversationWorkspace(
      conversationId,
      c.get("sandboxAbortSignal"),
    )
    if (!loaded) return c.json({ error: "Not found" }, 404)
    const ready = await readySandboxHandle({ ...loaded, existingOnly: true })
    if (!ready.ok) return c.json({ error: ready.error }, ready.status)
    const { handle } = ready
    const [paths, branchResult, worktreeVersion, revision] = await Promise.all([
      listConversationSandboxPaths(handle),
      handle.exec("git branch --show-current"),
      conversationWorktreeVersion(handle),
      getDesiredWorkspaceRevision(loaded.workspace.id),
    ])
    if (branchResult.exitCode !== 0)
      throw new Error("Conversation branch is unavailable")
    const branch = branchResult.stdout.trim()
    const binding = revision
      ? await getConversationSandboxBinding(conversationId, revision)
      : null
    return c.json(
      {
        sha: binding?.desiredSha ?? "HEAD",
        paths,
        branch,
        worktreeVersion,
      },
      200,
    )
  })
  .openapi(getBlobRoute, async (c) => {
    if (!requireUser(c)) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const path = c.req.query("path") ?? ""
    const loaded = await loadConversationWorkspace(
      conversationId,
      c.get("sandboxAbortSignal"),
    )
    if (!loaded) return c.json({ error: "Not found" }, 404)
    const ready = await readySandboxHandle(loaded)
    if (!ready.ok) return c.json({ error: ready.error }, ready.status)
    const { handle } = ready
    const blob = await readConversationSandboxFile(handle, path)
    if (!blob) return c.json({ error: "Not found" }, 404)
    return c.json(blob, 200)
  })
  .openapi(getStatusRoute, async (c) => {
    if (!requireUser(c)) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const loaded = await loadConversationWorkspace(
      conversationId,
      c.get("sandboxAbortSignal"),
    )
    if (!loaded) return c.json({ error: "Not found" }, 404)
    const ready = await readySandboxHandle({ ...loaded, existingOnly: true })
    if (!ready.ok) return c.json({ error: ready.error }, ready.status)
    const { handle } = ready
    const defaultBranch =
      loaded.workspace.desiredDefaultBranch?.trim() || "main"
    const [status, worktreeVersion, revision] = await Promise.all([
      conversationSandboxStatus({
        handle,
        defaultBranch,
        sessionBranch: sessionBranchName(conversationId),
      }),
      conversationWorktreeVersion(handle),
      getDesiredWorkspaceRevision(loaded.workspace.id),
    ])
    const binding = revision
      ? await getConversationSandboxBinding(conversationId, revision)
      : null
    return c.json(
      {
        source: "sandbox" as const,
        ...status,
        sha: binding?.desiredSha ?? null,
        desiredSha: revision?.sha ?? null,
        stale: binding?.desiredSha !== revision?.sha,
        worktreeVersion,
      },
      200,
    )
  })
  .openapi(getDiffRoute, async (c) => {
    if (!requireUser(c)) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const loaded = await loadConversationWorkspace(
      conversationId,
      c.get("sandboxAbortSignal"),
    )
    if (!loaded) return c.json({ error: "Not found" }, 404)
    const defaultBranch =
      loaded.workspace.desiredDefaultBranch?.trim() || "main"
    const ready = await readySandboxHandle(loaded)
    if (!ready.ok) return c.json({ error: ready.error }, ready.status)
    const { handle } = ready
    const items = await conversationSandboxDiff({ handle, defaultBranch })
    return c.json({ items }, 200)
  })
  .openapi(putFileRoute, async (c) => {
    if (!requireUser(c)) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const loaded = await loadConversationWorkspace(
      conversationId,
      c.get("sandboxAbortSignal"),
    )
    if (!loaded) return c.json({ error: "Not found" }, 404)
    if (
      !workspaceAllowsConversationEdits(
        loaded.workspace.writeStatus,
        loaded.workspace.readOnlyReason,
      )
    ) {
      return c.json({ error: "read_only" }, 403)
    }
    const ready = await readySandboxHandle(loaded)
    if (!ready.ok) return c.json({ error: ready.error }, ready.status)
    const { handle } = ready
    const body = PutConversationFileBodySchema.parse(await c.req.json())
    const currentVersion = await conversationWorktreeVersion(handle)
    if (
      body.expectedWorktreeVersion != null &&
      body.expectedWorktreeVersion !== currentVersion
    ) {
      return c.json(
        { error: "stale_worktree", worktreeVersion: currentVersion },
        409,
      )
    }
    if (body.deletePath) {
      await removeConversationSandboxPath({ handle, path: body.path })
    } else {
      if (body.from && body.from !== body.path) {
        await renameConversationSandboxPath({
          handle,
          from: body.from,
          to: body.path,
        })
      }
      if (body.body != null) {
        await writeConversationSandboxFile({
          handle,
          path: body.path,
          body: body.body,
        })
      }
    }
    const snapshot = await conversationFileSnapshot({
      handle,
      conversationId,
      workspace: loaded.workspace,
    })
    return c.json(
      {
        path: body.path,
        body: body.deletePath ? null : (body.body ?? null),
        binary: false,
        worktreeVersion: snapshot.worktreeVersion,
        tree: snapshot.tree,
        status: snapshot.status,
      },
      200,
    )
  })
  .openapi(postPushRoute, async (c) => {
    if (!requireUser(c)) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const loaded = await loadConversationWorkspace(
      conversationId,
      c.get("sandboxAbortSignal"),
    )
    if (!loaded) return c.json({ error: "Not found" }, 404)
    if (
      !workspaceAllowsConversationEdits(
        loaded.workspace.writeStatus,
        loaded.workspace.readOnlyReason,
      )
    ) {
      return c.json({ error: "read_only" }, 400)
    }
    const env = parseEnv(process.env as Record<string, string | undefined>)
    const revision = await getDesiredWorkspaceRevision(
      loaded.workspace.id,
      "publish-session",
    )
    if (!revision) return c.json({ error: "missing_revision" }, 409)
    const sandbox = await getConversationSandboxBinding(
      conversationId,
      revision,
    )
    if (!sandbox) return c.json({ error: "missing_sandbox" }, 409)
    const repoName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
    if (!repoName) return c.json({ error: "not_github" }, 400)
    const planned = planCapturedConversationPublication({
      revision,
      writeStatus: loaded.workspace.writeStatus,
      readOnlyReason: loaded.workspace.readOnlyReason,
      sandbox,
    })
    if (!planned.publish) return c.json({ error: planned.reason }, 400)
    const ready = await readySandboxHandle({ ...loaded, existingOnly: true })
    if (!ready.ok) return c.json({ error: ready.error }, ready.status)
    const { handle } = ready
    const pushed = await pushConversationSessionBranch({
      handle,
      conversationId,
      orgId: loaded.workspace.orgId,
      workspaceId: loaded.workspace.id,
      revision,
      env,
      commitMessage: loaded.conversation.name,
    })
    if (!pushed.ok) return c.json({ error: pushed.error }, 400)
    if (
      !(await persistConversationPublication({
        conversationId,
        lastBranch: pushed.branch,
        revision,
      }))
    )
      return c.json({ error: "stale_binding" }, 409)
    return c.json(
      {
        branch: pushed.branch,
        treeUrl: conversationGithubTreeUrl({
          repositoryName: repoName,
          branch: pushed.branch,
        }),
      },
      200,
    )
  })

export function conversationPublicPrUrl(input: {
  workspaceRepositoryUrl: string
  lastChatPrNumber: number | null
}): string | null {
  if (input.lastChatPrNumber == null) return null
  const repo = githubRepoFullNameFromWorkspaceUrl(input.workspaceRepositoryUrl)
  if (!repo) return null
  return conversationGithubPullUrl({
    repositoryName: repo,
    prNumber: input.lastChatPrNumber,
  })
}

export function conversationPublicTreeUrl(input: {
  workspaceRepositoryUrl: string
  lastBranch: string | null
}): string | null {
  if (!input.lastBranch?.startsWith("ctxpipe/chat/")) return null
  const repo = githubRepoFullNameFromWorkspaceUrl(input.workspaceRepositoryUrl)
  if (!repo) return null
  return conversationGithubTreeUrl({
    repositoryName: repo,
    branch: input.lastBranch,
  })
}
