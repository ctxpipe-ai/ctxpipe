import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { createMiddleware } from "hono/factory"
import type { AppEnv } from "../../app/env.js"
import { conversationSessionBranch as sessionBranchName } from "../../domain/workspaces/chat-lifecycle.js"
import { workspaceAllowsConversationEdits } from "../../domain/workspaces/chat-sandbox-policy.js"
import {
  changedFileDiffs,
  conversationBaseDiff,
  turnSnapshotsExist,
} from "../../domain/workspaces/conversation-diff.js"
import {
  attachTurnSandboxForRead,
  conversationSandboxStatus,
  conversationWorktreeVersion,
  getConversationSandboxBinding,
  listConversationSandboxPaths,
  readConversationSandboxFile,
  removeConversationSandboxPath,
  renameConversationSandboxPath,
  UnsafeConversationPathError,
  writeConversationSandboxFile,
} from "../../domain/workspaces/conversation-files.js"
import {
  conversationGithubPullUrl,
  conversationGithubTreeUrl,
} from "../../domain/workspaces/conversation-publish.js"
import { EXPLORER_GIT_STATUSES } from "../../domain/workspaces/git-explorer.js"
import { adaptTanstackHandle } from "../../domain/workspaces/job-sandbox.js"
import type { JobSandboxHandle } from "../../domain/workspaces/job-worktree.js"
import { LEGACY_KNOWLEDGE_READ_ONLY } from "../../domain/workspaces/legacy-knowledge-overlay.js"
import {
  postgresSandboxLocks,
  withSandboxLockIfFree,
} from "../../domain/workspaces/sandbox-lock-store.js"
import { warmTanstackWorkspaceChat } from "../../domain/workspaces/tanstack-workspace-chat.js"
import { resolveWorkspaceChatTurnRuntime } from "../../domain/workspaces/workspace-chat-turn-runtime.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import {
  listConversationSyncs,
  listConversationTurnChanges,
} from "../../models/conversation-turn-changes.js"
import { getConversation } from "../../models/conversations.js"
import {
  getDesiredWorkspaceRevision,
  getWorkspaceById,
  legacyKnowledgePaths,
  writesLegacyKnowledge,
} from "../../models/workspaces.js"
import { applyAttribution } from "../../observability/attribution.js"

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ConversationFileErrorResponse")

/** Every route that may start a chat sandbox can hit the org's limit. */
export const sandboxAtCapacityResponse = {
  content: { "application/json": { schema: ErrorResponseSchema } },
  description:
    "At capacity: the organization already runs its maximum number of chat sandboxes",
}

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
    readOnlyReason: z.string().optional().openapi({
      description:
        "Set when the file is knowledge from before Workspaces that is not in git. It cannot be edited.",
    }),
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
        status: z.enum(EXPLORER_GIT_STATUSES),
        additions: z.number().int().optional(),
        deletions: z.number().int().optional(),
      }),
    ),
    worktreeVersion: z.string(),
  })
  .openapi("ConversationGitStatusResponse")

const ChangedFileSchema = z.object({
  path: z.string(),
  /** The path before a rename. */
  oldPath: z.string().optional(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  /** Why the file has no bodies: binary, too large, or not a regular file. */
  omitted: z.enum(["binary", "too_large", "not_a_file"]).optional(),
})

const ConversationGitDiffResponseSchema = z
  .object({
    /** The branch the diff compares against. */
    base: z.string(),
    items: z.array(
      ChangedFileSchema.extend({
        oldBody: z.string().nullable(),
        body: z.string().nullable(),
      }),
    ),
  })
  .openapi("ConversationGitDiffResponse")

const ConversationTurnChangesResponseSchema = z
  .object({
    items: z.array(
      z.object({
        runId: z.string(),
        /** The number of user messages in the thread when the turn ended. */
        turn: z.number().int(),
        files: z.array(ChangedFileSchema),
      }),
    ),
    /** Each push of the conversation's commits, oldest first. */
    syncs: z.array(
      z.object({
        /** What pushed: the user's Sync or Create PR, the agent, or the sweep. */
        trigger: z.enum(["sync", "create_pr", "agent", "sweep"]),
        /** Create PR: the pull request; `opened` when this push opened it. */
        pullRequest: z
          .object({
            number: z.number().int(),
            url: z.string(),
            opened: z.boolean(),
          })
          .optional(),
        branch: z.string(),
        sha: z.string(),
        /** The number of files that the pushed commits changed. */
        files: z.number().int(),
        treeUrl: z.string(),
        /** The number of user messages in the thread at the time of the Sync. */
        turn: z.number().int(),
        syncedAt: z.string(),
      }),
    ),
  })
  .openapi("ConversationTurnChangesResponse")

const ConversationGitDiffQuerySchema = z
  .object({
    /** Give the diff of this turn (run id) in place of the whole conversation. */
    turn: z.string().min(1).optional(),
  })
  .openapi("ConversationGitDiffQuery")

const PutConversationFileBodySchema = z
  .object({
    path: z.string().min(1),
    body: z.string().optional(),
    deletePath: z.boolean().optional(),
    from: z.string().min(1).optional(),
    expectedWorktreeVersion: z.string().min(1),
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
    429: sandboxAtCapacityResponse,
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Sandbox provider unavailable",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Chat sandbox missing, or turn_running: a turn holds the conversation now (ask again later)",
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
    429: sandboxAtCapacityResponse,
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
    429: sandboxAtCapacityResponse,
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Sandbox provider unavailable",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "Chat sandbox missing, or turn_running: a turn holds the conversation now (ask again later)",
    },
  },
})

const getDiffRoute = createRoute({
  method: "get",
  path: "/{conversationId}/files/diff",
  request: {
    params: ConversationParamsSchema,
    query: ConversationGitDiffQuerySchema,
  },
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
    429: sandboxAtCapacityResponse,
    503: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Sandbox provider unavailable",
    },
    410: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description:
        "turn_snapshot_gone: the sandbox no longer has this turn's snapshots",
    },
    409: {
      content: { "application/json": { schema: ErrorResponseSchema } },
      description: "Chat sandbox missing",
    },
  },
})

const getTurnChangesRoute = createRoute({
  method: "get",
  path: "/{conversationId}/turns",
  request: { params: ConversationParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConversationTurnChangesResponseSchema },
      },
      description:
        "The files each turn changed, in turn order, and the conversation's syncs",
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
      description:
        "turn_running: a turn holds the conversation and records its changes when it ends (ask again later)",
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
    429: sandboxAtCapacityResponse,
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
  const runtime = await resolveWorkspaceChatTurnRuntime({
    conversation: input.conversation,
    workspace: input.workspace,
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
  lastBranch: string | null
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
        sessionBranch: sessionBranchName(
          input.conversationId,
          input.lastBranch,
        ),
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
  Variables: {
    sandboxAbortSignal: AbortSignal
    readWithoutWait?: boolean
    readDuringTurn?: boolean
    turnRunning?: boolean
  }
}
/**
 * A turn holds the conversation lock until its reply ends. The Files pane
 * polls the tree and status, so these reads do not wait for the lock: when a
 * turn holds it, they answer 409 `turn_running` and the pane polls again.
 */
const readWithoutWait = createMiddleware<ConversationFileEnv>(
  async (c, next) => {
    c.set("readWithoutWait", true)
    await next()
  },
)
/**
 * A file read does not wait for a turn either: when another holder has the
 * lock, it reads from the running sandbox with a plain attach that changes
 * nothing, or answers 409 `turn_running` when no sandbox runs.
 */
const readDuringTurn = createMiddleware<ConversationFileEnv>(
  async (c, next) => {
    c.set("readDuringTurn", true)
    await next()
  },
)
const withConversationFileLock = createMiddleware<ConversationFileEnv>(
  async (c, next) => {
    if (!requireUser(c)) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const loaded = conversationId
      ? await loadConversationWorkspace(conversationId)
      : null
    if (!loaded) return c.json({ error: "Not found" }, 404)
    applyAttribution({ "ctxpipe.conversation.id": loaded.conversation.id })
    const controller = new AbortController()
    const onRequestAbort = () => controller.abort(c.req.raw.signal.reason)
    c.req.raw.signal.addEventListener("abort", onRequestAbort, { once: true })
    if (c.req.raw.signal.aborted) onRequestAbort()
    c.set("sandboxAbortSignal", controller.signal)
    const orgId = loaded.conversation.orgId
    const key = `chat-thread:${conversationId}`
    try {
      if (c.get("readWithoutWait") || c.get("readDuringTurn")) {
        const read = await withSandboxLockIfFree(
          orgId,
          key,
          () => next(),
          controller,
        )
        if (!read.busy) return
        if (!c.get("readDuringTurn"))
          return c.json({ error: "turn_running" }, 409)
        c.set("turnRunning", true)
        return await next()
      }
      return await postgresSandboxLocks(orgId, controller).withLock(key, () =>
        next(),
      )
    } finally {
      c.req.raw.signal.removeEventListener("abort", onRequestAbort)
    }
  },
)
const fileRoutes = new OpenAPIHono<ConversationFileEnv>()
fileRoutes.get("/:conversationId/files/tree", readWithoutWait)
fileRoutes.get("/:conversationId/files/status", readWithoutWait)
fileRoutes.get("/:conversationId/files/blob", readDuringTurn)
fileRoutes.use("/:conversationId/files/*", withConversationFileLock)
// A turn records its changes before it releases the lock. A read while the
// lock is held would miss them, so it answers 409 and the UI asks again.
fileRoutes.get("/:conversationId/turns", readWithoutWait)
fileRoutes.use("/:conversationId/turns", withConversationFileLock)
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
    let handle: JobSandboxHandle
    if (c.get("turnRunning")) {
      const attached = await attachTurnSandboxForRead({
        orgId: loaded.conversation.orgId,
        conversationId,
        signal: c.get("sandboxAbortSignal"),
      })
      // Nothing runs to read (the idle sweep may hold the lock): the pane
      // polls again.
      if (!attached) return c.json({ error: "turn_running" }, 409)
      handle = attached
    } else {
      const ready = await readySandboxHandle({ ...loaded, existingOnly: true })
      if (!ready.ok) return c.json({ error: ready.error }, ready.status)
      handle = ready.handle
    }
    const blob = await readConversationSandboxFile(handle, path)
    if (blob) return c.json(blob, 200)
    // A main-era knowledge unit that hydrate serves from Postgres: it is not
    // in the sandbox, and it is read-only.
    const legacy = (
      await legacyKnowledgePaths(loaded.workspace.id, [path])
    ).get(path)
    if (legacy === undefined) return c.json({ error: "Not found" }, 404)
    return c.json(
      {
        path,
        body: legacy,
        binary: false,
        readOnlyReason: LEGACY_KNOWLEDGE_READ_ONLY,
      },
      200,
    )
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
        sessionBranch: sessionBranchName(
          conversationId,
          loaded.conversation.lastBranch,
        ),
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
    const turnId = c.req.valid("query").turn
    if (turnId) {
      const turn = (
        await listConversationTurnChanges({
          orgId: loaded.conversation.orgId,
          conversationId,
        })
      ).find((item) => item.runId === turnId)
      if (!turn) return c.json({ error: "Not found" }, 404)
      // A rebuilt sandbox no longer has the turn's snapshots.
      if (!(await turnSnapshotsExist(handle, turn.startTree, turn.endTree)))
        return c.json({ error: "turn_snapshot_gone" }, 410)
      const paths = new Set(turn.files.map((file) => file.path))
      const items = (
        await changedFileDiffs(handle, turn.startTree, turn.endTree)
      ).filter((item) => paths.has(item.path))
      return c.json({ base: defaultBranch, items }, 200)
    }
    const items = await conversationBaseDiff({ handle, defaultBranch })
    return c.json({ base: defaultBranch, items }, 200)
  })
  .openapi(getTurnChangesRoute, async (c) => {
    if (!requireUser(c)) return c.json({ error: "Unauthorized" }, 401)
    const conversationId = c.req.param("conversationId")
    const loaded = await loadConversationWorkspace(conversationId)
    if (!loaded) return c.json({ error: "Not found" }, 404)
    const scope = { orgId: loaded.conversation.orgId, conversationId }
    const [turns, syncs] = await Promise.all([
      listConversationTurnChanges(scope),
      listConversationSyncs(scope),
    ])
    return c.json(
      {
        items: turns.map(({ runId, turn, files }) => ({ runId, turn, files })),
        syncs,
      },
      200,
    )
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
    // A main-era knowledge unit is not in git: it is read-only.
    if (
      await writesLegacyKnowledge(loaded.workspace.id, [body.path, body.from])
    )
      return c.json({ error: LEGACY_KNOWLEDGE_READ_ONLY }, 403)
    const currentVersion = await conversationWorktreeVersion(handle)
    if (body.expectedWorktreeVersion !== currentVersion) {
      return c.json(
        { error: "stale_worktree", worktreeVersion: currentVersion },
        409,
      )
    }
    try {
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
    } catch (error) {
      if (error instanceof UnsafeConversationPathError) {
        return c.json({ error: "unsafe_path" }, 400)
      }
      throw error
    }
    const snapshot = await conversationFileSnapshot({
      handle,
      conversationId,
      lastBranch: loaded.conversation.lastBranch,
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
