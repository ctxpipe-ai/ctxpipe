import type { Env } from "../../config/env.js"
import { sourceRowsNameRepository } from "../../models/workspace-source-state.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import type { GitFileChange } from "../../services/git/file-change.js"
import {
  type GitPack,
  type GitRemoteRead,
  listPackBlobs,
  readGitFiles,
  withGitDirectory,
} from "../../services/git/pack.js"
import { unsafeMirrorPath } from "../workspace-sources/mirror-path.js"
import { sourcesHaveNoRepository } from "../workspace-sources/projection-plan.js"
import { readSourcesTree } from "../workspace-sources/source-tree.js"
import {
  resolveWorkspaceReadRevision,
  workspaceGitRead,
} from "./resolve-revision.js"
import { workspaceRootPath } from "./root-path.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"

/** `github/<pulls|issues>/<owner>/<repo>/<file>`: one mirror file. */
const MIRROR_FILE = /^github\/(pulls|issues)\/([^/]+)\/([^/]+)\/([^/]+)$/

/** Counts only: the plan names no repository and no file. */
export type GithubMirrorCleanupCounts = {
  /** Mixed-case copies that the plan deletes, because a lowercase copy exists. */
  duplicates: number
  /** Mixed-case files that the plan moves to the lowercase path. */
  moves: number
  /** Mirror folders of repositories that no source of the Workspace holds. */
  removedSourceFolders: number
  /** The files in those folders. */
  removedSourceFiles: number
  /** Mixed-case files that the plan leaves, because the lowercase path is not safe. */
  skipped: number
}

export type GithubMirrorCleanupPlan = {
  files: GitFileChange[]
  deletePaths: string[]
  counts: GithubMirrorCleanupCounts
}

/**
 * The one-time cleanup of the GitHub pull request and issue mirrors of one
 * Workspace (CTX-1693), at the commit of `pack`:
 *
 * 1. Before 2026-10-20 the mirror path used the owner and repository name of
 *    GitHub, in mixed case. Now it uses the lowercase name. When the
 *    lowercase copy of a mixed-case file exists, the plan deletes the
 *    mixed-case copy. Else it moves the file to the lowercase path.
 * 2. No path deletes the mirror of a repository that left the sources. The
 *    plan deletes each mirror folder of a repository that no source holds.
 *    It uses the fence of the unlink retraction (CTX-710): a source entry
 *    that names the repository keeps it, also when the entry is invalid; a
 *    source file that cannot be read keeps every repository; and a stored
 *    source row that names the repository keeps it.
 *
 * The plan touches only `github/pulls/` and `github/issues/`.
 */
export async function planGithubMirrorCleanup(input: {
  orgId: string
  workspaceId: string
  pack: GitPack
  read: GitRemoteRead | null
}): Promise<GithubMirrorCleanupPlan> {
  const paths = (
    await withGitDirectory(
      input.pack.sha,
      (directory) => listPackBlobs(directory, input.pack),
      input.pack,
      input.read,
    )
  ).flatMap(({ path }) => {
    const match = MIRROR_FILE.exec(path)
    if (!match) return []
    const [, folder = "", owner = "", repo = "", name = ""] = match
    const repository = `${owner}/${repo}`.toLowerCase()
    return [
      {
        path,
        repository,
        lowercasePath: `github/${folder}/${repository}/${name}`,
      },
    ]
  })
  const counts: GithubMirrorCleanupCounts = {
    duplicates: 0,
    moves: 0,
    removedSourceFolders: 0,
    removedSourceFiles: 0,
    skipped: 0,
  }
  if (paths.length === 0) return { files: [], deletePaths: [], counts }

  const { sourcesFile, sourceFiles } = await readSourcesTree(
    input.pack,
    input.read,
  )
  const rows = await listWorkspaceSourceRows(input)
  const held = new Map<string, boolean>()
  for (const repository of new Set(paths.map((file) => file.repository))) {
    const gitUrl = normalizeWorkspaceRepositoryUrl(
      `https://github.com/${repository}`,
    )
    held.set(
      repository,
      !(await sourcesHaveNoRepository(
        { text: sourcesFile, sourceFiles },
        gitUrl,
      )) || sourceRowsNameRepository(rows, gitUrl),
    )
  }

  const deletePaths: string[] = []
  const removedFolders = new Set<string>()
  const existing = new Set(paths.map((file) => file.path))
  // The mixed-case file that moves to each lowercase path.
  const moves = new Map<string, string>()
  for (const file of [...paths].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!held.get(file.repository)) {
      deletePaths.push(file.path)
      removedFolders.add(file.path.slice(0, file.path.lastIndexOf("/")))
      counts.removedSourceFiles++
      continue
    }
    if (file.path === file.lowercasePath) continue
    if (existing.has(file.lowercasePath) || moves.has(file.lowercasePath)) {
      deletePaths.push(file.path)
      counts.duplicates++
      continue
    }
    if (unsafeMirrorPath(file.lowercasePath) !== null) {
      counts.skipped++
      continue
    }
    moves.set(file.lowercasePath, file.path)
    deletePaths.push(file.path)
    counts.moves++
  }
  counts.removedSourceFolders = removedFolders.size

  const sources = new Set(moves.values())
  const moved = new Map(
    (
      await readGitFiles(
        input.pack,
        (path) => sources.has(path),
        undefined,
        input.read,
      )
    ).map((file) => [file.path, file.content]),
  )
  const files = [...moves].map(([path, from]) => {
    const content = moved.get(from)
    if (content === undefined)
      throw new Error("A mirror file to move is missing from the tree")
    return { path, content }
  })
  return { files, deletePaths, counts }
}

/**
 * The dry run of the cleanup: the counts of the plan at the current tip of
 * the default branch. It writes nothing. The job plans again on the tip that
 * it pushes on, so its counts can differ when the tip moves.
 */
export async function dryRunGithubMirrorCleanup(input: {
  orgId: string
  workspaceId: string
  env: Env
}): Promise<GithubMirrorCleanupCounts> {
  const resolved = await resolveWorkspaceReadRevision(input)
  if (!resolved) throw new Error("The Workspace has no revision to read")
  const { revision } = resolved
  const root = workspaceRootPath(revision)
  const plan = await planGithubMirrorCleanup({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    pack: {
      sha: revision.sha,
      objects: "",
      shallow: "",
      ...(root ? { root } : {}),
      base: { url: revision.remote.url, shas: [revision.sha] },
    },
    read: workspaceGitRead({ ...input, remote: revision.remote }),
  })
  return plan.counts
}
