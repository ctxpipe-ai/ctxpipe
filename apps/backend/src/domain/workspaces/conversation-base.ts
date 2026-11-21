import { createError } from "evlog"
import { z } from "zod"

import type { Env } from "../../config/env.js"
import { listGitRemoteBranches } from "../../services/git/clone-tree.js"
import { isChatSessionBranch } from "./chat-lifecycle.js"
import { resolveRepositoryReadCredential } from "./resolve-revision.js"
import type { WorkspaceRevision } from "./revision.js"

/*
 * The base branch of a conversation (ADR-071, the chat branch selector). The
 * user picks it before the first message. The session branch starts from
 * it, each turn rebases on its tip, and the pull request targets it. A
 * conversation with no base branch uses the default branch.
 */

/**
 * A branch name that a conversation may start from. Git checks the rest of
 * the name rules: a name that it refuses has no branch on the remote. A
 * session branch of a conversation is not a base.
 */
export const baseBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine(
    (name) =>
      !name.startsWith("-") &&
      !name.includes("..") &&
      !isChatSessionBranch(name),
    "A session branch of a conversation is not a base branch",
  )

/** A requested base branch, checked; throws a 400 error for a bad name. */
export function parseBaseBranch(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const parsed = baseBranchSchema.safeParse(name)
  if (!parsed.success)
    throw createError({
      message: "Invalid base branch",
      status: 400,
      why: "A base branch is a branch name, and not a session branch of a conversation",
    })
  return parsed.data
}

type RepositoryRead = {
  orgId: string
  env: Env
  revision: WorkspaceRevision
}

/**
 * The branches that a conversation of the Workspace can start from: the
 * default branch first, then the others by name, without the session
 * branches of conversations.
 */
export async function listConversationBaseBranches(
  input: RepositoryRead,
): Promise<string[]> {
  const token = await resolveRepositoryReadCredential({
    ...input,
    remote: input.revision.remote,
  })
  const branches = await listGitRemoteBranches({
    url: input.revision.remote.url,
    token,
  })
  const others = branches
    .map((branch) => branch.name)
    .filter(
      (name) =>
        name !== input.revision.defaultBranch && !isChatSessionBranch(name),
    )
  return [input.revision.defaultBranch, ...others]
}

/** The tip of a base branch on the remote, or null when it has no such branch. */
export async function baseBranchTip(input: {
  orgId: string
  env: Env
  remote: WorkspaceRevision["remote"]
  branch: string
}): Promise<string | null> {
  const token = await resolveRepositoryReadCredential(input)
  const [tip] = await listGitRemoteBranches({
    url: input.remote.url,
    token,
    branch: input.branch,
  })
  return tip?.sha ?? null
}

/**
 * The revision that a conversation builds on: the Workspace revision, or for
 * a base branch that is not the default branch the same binding at the tip
 * of that branch. Null: the remote has no such branch.
 */
export async function conversationRevision(
  input: RepositoryRead & { baseBranch: string | null },
): Promise<WorkspaceRevision | null> {
  const { revision, baseBranch } = input
  if (!baseBranch || baseBranch === revision.defaultBranch) return revision
  const sha = await baseBranchTip({
    ...input,
    remote: revision.remote,
    branch: baseBranch,
  })
  return sha ? { ...revision, baseBranch, sha } : null
}
