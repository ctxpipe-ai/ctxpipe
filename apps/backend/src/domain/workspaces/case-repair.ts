import type { Env } from "../../config/env.js"
import { getRepoWriteCloneToken } from "../../models/github-installation.js"
import {
  getDesiredWorkspaceRevision,
  getWorkspaceWriteAdmission,
} from "../../models/workspaces.js"
import {
  fetchGitHistory,
  gitRemoteEnvironment,
  readPathHistory,
} from "../../services/git/clone-tree.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import {
  type GitPack,
  type GitRemoteRead,
  listPackBlobs,
  nativeGit,
  readGitBlobs,
  withGitDirectory,
} from "../../services/git/pack.js"
import { workspaceRepositoryPath } from "../../services/git/root-folder.js"
import { prepareGitCommit } from "../../services/git/write-tree.js"
import {
  createPullRequestFromBranch,
  listOpenPullRequestsByBranchPrefix,
} from "../../services/github/installation-write-client.js"
import { isConnectorMirrorPath } from "../codeIngestion/connectorMirrorPaths.js"
import { caseGroups, compareCopies, foldPath } from "./case-duplicates.js"
import { isHostOnlyPath } from "./host-only.js"
import { parseSimpleFrontMatter } from "./layout.js"
import { workspaceGitRead } from "./resolve-revision.js"
import { workspaceAdmitsRevision } from "./revision.js"
import { workspaceRevisionPack } from "./root-path.js"
import { resolveSemanticConflicts } from "./semantic-merge.js"
import { documentTimes, withGitTimes } from "./source-time.js"
import { writeAccessDenialReason } from "./write-broker.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/*
 * The repair of case duplicates (CTX-1697, ADR-071 decision 5). The reads
 * are correct without it. A repair is a normal commit that the projection
 * reads as any other, and it keeps the canonical path: the folded path
 * (NFC, then lowercase).
 * - Copies with the same content, and copies of files that ctxpipe owns (a
 *   connector mirror, or a file with `generated_by`): one direct commit
 *   through the write broker.
 * - Two copies that differ and that people or agents edited: a pull request
 *   with a semantic merge into one file. A person decides.
 */

/** The most model calls of one run of the pull request of the repair. */
const MERGE_CALLS = 20

/** Counts only: the plan names no file. */
type CaseRepairCounts = {
  /** Groups of copies with the same content. */
  identical: number
  /** Groups of copies of files that ctxpipe owns. */
  owned: number
  /** Groups of edited copies that differ: the pull request merges them. */
  merges: number
  /**
   * Groups that no repair changes: a host-only path, a binary file, or a
   * file with more copies than one run can merge.
   */
  skipped: number
}

/** The copies of one folded path. */
type CaseGroup = {
  /** The folded path: the path that the repair keeps. */
  canonical: string
  /** The copy that the reads show first, then the canonical path, then the byte order. */
  copies: Array<{ path: string; updatedAt: string | null; bytes: Buffer }>
}

type CaseRepairPlan = {
  /** The change of the direct commit. */
  direct: { files: GitFileChange[]; deletePaths: string[] }
  /** The groups that the pull request merges. */
  merges: CaseGroup[]
  counts: CaseRepairCounts
}

/**
 * The plan of the repair of the tree at `pack`. The copy that the reads
 * show stays: the copy that Git changed last ({@link compareCopies}). The
 * plan reads that time from the Git history of the tree, as the knowledge
 * plane does, so it needs no projection.
 */
export async function planCaseRepair(input: {
  pack: GitPack
  read: GitRemoteRead | null
}): Promise<CaseRepairPlan> {
  const groups = await withGitDirectory(
    input.pack.sha,
    async (directory) => {
      const blobOf = new Map(
        (await listPackBlobs(directory, input.pack)).map((blob) => [
          blob.path,
          blob.sha,
        ]),
      )
      const groups = caseGroups(blobOf.keys())
      if (groups.length === 0) return []
      const bytes = await readGitBlobs(
        directory,
        groups.flat().map((path) => blobOf.get(path) ?? ""),
      )
      let next = 0
      const files = groups.map((paths) =>
        paths.map((path) => ({
          path,
          bytes: bytes[next++] ?? Buffer.alloc(0),
        })),
      )
      const updatedAt = await copyTimes(directory, input, files.flat())
      return files.map((copies): CaseGroup => ({
        canonical: foldPath(copies[0]?.path ?? ""),
        copies: copies
          .map((copy) => ({
            ...copy,
            updatedAt: updatedAt.get(copy.path) ?? null,
          }))
          .sort(compareCopies),
      }))
    },
    input.pack,
    input.read,
  )
  const counts: CaseRepairCounts = {
    identical: 0,
    owned: 0,
    merges: 0,
    skipped: 0,
  }
  const direct: CaseRepairPlan["direct"] = { files: [], deletePaths: [] }
  const merges: CaseGroup[] = []
  for (const group of groups) {
    const [shown] = group.copies
    if (!shown) continue
    if (group.copies.some((copy) => isHostOnlyPath(copy.path))) {
      counts.skipped++
      continue
    }
    const identical = group.copies.every((copy) =>
      copy.bytes.equals(shown.bytes),
    )
    const owned = group.copies.every(
      (copy) =>
        // A mirror folder of another case is the same folder on a checkout
        // that ignores case.
        isConnectorMirrorPath(foldPath(copy.path)) ||
        (foldPath(copy.path).endsWith(".md") &&
          typeof parseSimpleFrontMatter(copy.bytes.toString("utf8")).attributes
            .generated_by === "string"),
    )
    if (!identical && !owned) {
      // The merge model reads text only: a person merges binary copies.
      // Each copy after the first is one model call, and a person who can
      // commit can add many: a person merges a file that needs more calls
      // than one run makes.
      if (
        group.copies.length - 1 > MERGE_CALLS ||
        group.copies.some((copy) => copy.bytes.includes(0))
      )
        counts.skipped++
      else {
        merges.push(group)
        counts.merges++
      }
      continue
    }
    counts[identical ? "identical" : "owned"]++
    // The copy that the reads show goes to the canonical path.
    if (shown.path !== group.canonical)
      direct.files.push({
        path: group.canonical,
        content: shown.bytes.toString("base64"),
        encoding: "base64",
      })
    direct.deletePaths.push(
      ...group.copies
        .map((copy) => copy.path)
        .filter((path) => path !== group.canonical),
    )
  }
  return { direct, merges, counts }
}

/**
 * The `updatedAt` of each copy, as the knowledge plane gives it
 * (`withGitTimes`, CTX-1710): the time that the file states, else, for an
 * authored file, the last commit that changed the path. One walk of the
 * history, with each merge as its change to the branch (`fetchGitHistory`
 * gets it from the remote of the Workspace).
 */
async function copyTimes(
  directory: string,
  input: { pack: GitPack; read: GitRemoteRead | null },
  copies: Array<{ path: string; bytes: Buffer }>,
): Promise<Map<string, string | null>> {
  const { pack, read } = input
  if (read)
    await fetchGitHistory(directory, {
      url: read.url,
      sha: pack.sha,
      token: await read.token(),
    })
  const root = pack.root ?? ""
  const { introduced, lastChanged } = await readPathHistory(directory, {
    sha: pack.sha,
    root,
    allPaths: true,
    mergeChanges: true,
  })
  const gitTime = (times: Map<string, string>, path: string) =>
    times.get(workspaceRepositoryPath(root, path)) ?? null
  return new Map(
    copies.map(({ path, bytes }) => {
      const parsed = foldPath(path).endsWith(".md")
        ? parseSimpleFrontMatter(bytes.toString("utf8"))
        : null
      const stated = parsed
        ? documentTimes({ path, ...parsed })
        : { createdAt: null, updatedAt: null, expiresAt: null }
      return [
        path,
        withGitTimes(path, stated, {
          introducedAt: gitTime(introduced, path),
          lastChangedAt: gitTime(lastChanged, path),
        }).updatedAt,
      ]
    }),
  )
}

/** The branch prefix of the pull requests of the repair. */
const CASE_MERGE_BRANCH = "ctxpipe/case-duplicates"

/**
 * The pull request that merges each group of edited copies that differ, at
 * the tip that the Workspace wants now: the direct commit of the repair can
 * move the tip after the tip check. The merge model makes one file at the canonical
 * path from the copies, and the pull request deletes the other copies. A
 * person reviews and merges it. While a pull request of the repair is open,
 * no second one opens.
 *
 * One run makes at most 20 model calls (one for each copy after the first of
 * a group), because they run in one workflow step. It takes the groups in
 * the order of the plan and stops at the first group that does not fit.
 * The groups after it wait, and the result and the pull request give their
 * count. When a person merges the pull request, the tip check of the new tip
 * opens the next one.
 */
export async function openCaseMergePullRequest(input: {
  orgId: string
  workspaceId: string
  env: Env
  createdAt: Date | string
}): Promise<
  | { kind: "none" }
  | { kind: "open"; pullUrl: string; merges: number; deferred: number }
  | { kind: "already_open"; pullUrl: string }
  | { kind: "refused"; reason: string }
> {
  const { env } = input
  const revision = await getDesiredWorkspaceRevision(
    input.workspaceId,
    "publish-session",
  )
  if (!revision) return { kind: "refused", reason: "no_revision" }
  const repositoryName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
  const githubConnectionId = revision.remote.connectionId
  if (!repositoryName || !githubConnectionId)
    return { kind: "refused", reason: "no_github_connection" }
  const read = workspaceGitRead({
    orgId: input.orgId,
    env,
    remote: revision.remote,
  })
  const pack = workspaceRevisionPack(revision)
  const { merges } = await planCaseRepair({ pack, read })
  if (merges.length === 0) return { kind: "none" }
  const github = { orgId: input.orgId, env, repositoryName, githubConnectionId }
  const [open] = await listOpenPullRequestsByBranchPrefix({
    ...github,
    branchPrefix: CASE_MERGE_BRANCH,
  })
  if (open) return { kind: "already_open", pullUrl: open.pullUrl }

  const files: GitFileChange[] = []
  const deletePaths: string[] = []
  let calls = 0
  let deferred = 0
  for (const [index, group] of merges.entries()) {
    calls += group.copies.length - 1
    if (calls > MERGE_CALLS) {
      deferred = merges.length - index
      break
    }
    // Each copy merges into the result of the copies before it.
    let merged: string | null = group.copies[0]?.bytes.toString("utf8") ?? null
    for (const copy of group.copies.slice(1)) {
      const [file] = await resolveSemanticConflicts(
        [
          {
            path: group.canonical,
            base: null,
            current: merged,
            incoming: copy.bytes.toString("utf8"),
          },
        ],
        { origin: "agent" },
      )
      merged = file?.content ?? null
    }
    if (merged === null) continue
    files.push({ path: group.canonical, content: merged })
    deletePaths.push(
      ...group.copies
        .map((copy) => copy.path)
        .filter((path) => path !== group.canonical),
    )
  }
  if (files.length === 0) return { kind: "none" }
  const branch = `${CASE_MERGE_BRANCH}-${revision.sha.slice(0, 12)}`
  let refused: string | null = null
  await prepareGitCommit({
    pack,
    files,
    deletePaths,
    subject:
      "ctxpipe - Merge the copies of files whose paths differ only in case",
    createdAt: input.createdAt,
    read,
    publish: async (directory, sha) => {
      // The Workspace can change during the model calls and while GitHub
      // issues the token: a detach, a new binding, or a loss of write
      // access. Read the binding and the write access from one row version
      // before the token, and again just before the push.
      const admitted = async () => {
        const admission = await getWorkspaceWriteAdmission(input.workspaceId)
        return (
          !!admission &&
          admission.writeStatus === "writable" &&
          workspaceAdmitsRevision(
            { ...admission.revision, access: revision.access },
            revision,
          )
        )
      }
      if (!(await admitted())) {
        refused = "stale"
        return
      }
      // GitHub can refuse the token or the push: a protected branch, or no
      // write access. Then the run gives `refused`, as for no token.
      const denied = (error: unknown) => {
        if (!writeAccessDenialReason(error)) throw error
        refused = "no_write_access"
        return null
      }
      const token = await getRepoWriteCloneToken(input.orgId, env, {
        githubConnectionId,
        repoFullName: repositoryName,
      }).catch(denied)
      if (!token) {
        refused = "no_write_access"
        return
      }
      if (!(await admitted())) {
        refused = "stale"
        return
      }
      await nativeGit(
        directory,
        [
          "push",
          "--porcelain",
          "--",
          revision.remote.url,
          `+${sha}:refs/heads/${branch}`,
        ],
        undefined,
        gitRemoteEnvironment({ url: revision.remote.url, token }),
      ).catch(denied)
    },
  })
  if (refused) return { kind: "refused", reason: refused }
  const created = await createPullRequestFromBranch({
    ...github,
    revision,
    baseBranch: revision.defaultBranch,
    branch,
    title: "ctxpipe: merge files whose paths differ only in case",
    body: [
      "Some files of this Workspace have two paths that differ only in case. On macOS and Windows, such paths are one file, so an agent can read the wrong copy.",
      "",
      "ctxpipe merged the copies of each file into the lowercase path with a model, and this pull request deletes the other copies. Check that each merged file keeps the right text, then merge the pull request.",
      "",
      ...files.map((file) => `- \`${file.path}\``),
      ...(deferred > 0
        ? [
            "",
            `${deferred === 1 ? "1 more file has" : `${deferred} more files have`} copies like this. ctxpipe merges them in a later pull request, after you merge this one.`,
          ]
        : []),
    ].join("\n"),
  })
  if (!created) return { kind: "refused", reason: "stale" }
  if ("refused" in created) return { kind: "refused", reason: created.refused }
  return {
    kind: "open",
    pullUrl: created.pullUrl,
    merges: files.length,
    deferred,
  }
}
