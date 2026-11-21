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
 * True for a name that Git accepts as a branch (the rules of
 * `git check-ref-format --branch`). A name that starts with "-" is also
 * refused, so that no Git command reads it as an option.
 */
function isGitBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== "@" &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.includes("@{") &&
    // Control characters, space and the characters that Git refuses.
    // oxlint-disable-next-line no-control-regex -- Git refuses control characters
    !/[\u0000- \u007f~^:?*[\\]/.test(name) &&
    name
      .split("/")
      .every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
  )
}

/**
 * A branch name that a conversation may start from: a Git branch name that
 * is not a session branch of a conversation. The remote says if the branch
 * exists.
 */
export const baseBranchSchema = z
  .string()
  .refine(
    (name) => isGitBranchName(name) && !isChatSessionBranch(name),
    "A base branch is a Git branch name, and not a session branch of a conversation",
  )

/** A requested base branch, checked; throws a 400 error for a bad name. */
export function parseBaseBranch(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const parsed = baseBranchSchema.safeParse(name)
  if (!parsed.success)
    throw createError({
      message: "Invalid base branch",
      status: 400,
      why: "A base branch is a Git branch name, and not a session branch of a conversation",
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
 * default branch first, then the others by name. A session branch of a
 * conversation is not in the list.
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
        name !== input.revision.defaultBranch &&
        baseBranchSchema.safeParse(name).success,
    )
  return [input.revision.defaultBranch, ...others]
}

/**
 * The tips that this process read last, by remote and branch, for the reads
 * that accept an older tip (`maxAgeMs`).
 */
const knownTips = new Map<string, { sha: string | null; at: number }>()

/**
 * The tip of a base branch on the remote, or null when it has no such
 * branch. A prepare and a turn read it from the remote. A Files read takes
 * a tip that is at most `maxAgeMs` old, so that a status poll does not ask
 * the remote each time.
 */
export async function baseBranchTip(input: {
  orgId: string
  env: Env
  remote: WorkspaceRevision["remote"]
  branch: string
  maxAgeMs?: number
}): Promise<string | null> {
  const key = JSON.stringify([input.remote.url, input.branch])
  const known = knownTips.get(key)
  if (known && input.maxAgeMs && Date.now() - known.at <= input.maxAgeMs)
    return known.sha
  const token = await resolveRepositoryReadCredential(input)
  const [tip] = await listGitRemoteBranches({
    url: input.remote.url,
    token,
    branch: input.branch,
  })
  const sha = tip?.sha ?? null
  knownTips.set(key, { sha, at: Date.now() })
  return sha
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
