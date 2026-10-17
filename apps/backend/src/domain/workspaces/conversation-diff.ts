import {
  CONVERSATION_BASE,
  isConversationSandboxListedPath,
  splitGitNulPaths,
} from "./conversation-files.js"
import type { JobSandboxHandle } from "./job-worktree.js"

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed"

/** Why a changed file has no bodies: the UI shows this in place of a diff. */
export type ChangedFileOmitted = "binary" | "too_large" | "not_a_file"

export type ChangedFile = {
  path: string
  /** The path before a rename. */
  oldPath?: string
  status: ChangedFileStatus
  additions: number
  deletions: number
  omitted?: ChangedFileOmitted
}

export type ChangedFileDiff = ChangedFile & {
  oldBody: string | null
  body: string | null
}

/** A larger file gets no body; the pane shows "File too large to show". */
export const DIFF_BODY_LIMIT_BYTES = 1024 * 1024

const ZERO_SHA = /^0+$/

type RawEntry = ChangedFile & { oldSha: string; newSha: string }

async function gitOk(
  handle: JobSandboxHandle,
  command: string,
  env: Record<string, string> = {},
): Promise<string> {
  const result = await handle.exec(command, { env })
  if (result.exitCode !== 0)
    throw new Error(result.stderr || `Command failed: ${command}`)
  return result.stdout
}

/**
 * The changed files between two tree-ish objects, from one `git diff` with
 * renames on: the status, the line counts, and the blobs for the bodies.
 */
async function diffEntries(
  handle: JobSandboxHandle,
  from: string,
  to: string,
): Promise<RawEntry[]> {
  if (from === to) return []
  const stdout = await gitOk(
    handle,
    'git diff --no-ext-diff --no-textconv --raw --no-abbrev --numstat -z -M "$CTXPIPE_FROM" "$CTXPIPE_TO"',
    { CTXPIPE_FROM: from, CTXPIPE_TO: to },
  )
  const tokens = splitGitNulPaths(stdout)
  const entries = new Map<string, RawEntry>()
  const counts = new Map<
    string,
    { additions: number; deletions: number } | null
  >()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ""
    if (token.startsWith(":")) {
      // :<old mode> <new mode> <old sha> <new sha> <status>
      const [oldMode, newMode, oldSha = "", newSha = "", code = ""] = token
        .slice(1)
        .split(" ")
      const renamed = code.startsWith("R") || code.startsWith("C")
      const first = tokens[++index] ?? ""
      const path = renamed ? (tokens[++index] ?? "") : first
      const status: ChangedFileStatus = code.startsWith("R")
        ? "renamed"
        : code === "A" || code.startsWith("C")
          ? "added"
          : code === "D"
            ? "deleted"
            : "modified"
      const notAFile = [oldMode, newMode].some(
        (mode) => mode === "120000" || mode === "160000",
      )
      entries.set(path, {
        path,
        ...(renamed ? { oldPath: first } : {}),
        status,
        additions: 0,
        deletions: 0,
        ...(notAFile ? { omitted: "not_a_file" as const } : {}),
        oldSha,
        newSha,
      })
      continue
    }
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token)
    if (!match) continue
    let path = match[3] ?? ""
    if (path === "") {
      index += 2
      path = tokens[index] ?? ""
    }
    counts.set(
      path,
      match[1] === "-"
        ? null
        : {
            additions: Number.parseInt(match[1] ?? "0", 10),
            deletions: Number.parseInt(match[2] ?? "0", 10),
          },
    )
  }
  const files: RawEntry[] = []
  for (const entry of entries.values()) {
    if (!isConversationSandboxListedPath(entry.path)) continue
    if (entry.oldPath && !isConversationSandboxListedPath(entry.oldPath))
      continue
    const count = counts.get(entry.path)
    if (count === null && !entry.omitted) entry.omitted = "binary"
    if (count) Object.assign(entry, count)
    files.push(entry)
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function publicFile(entry: RawEntry): ChangedFile {
  const { oldSha: _old, newSha: _new, ...file } = entry
  return file
}

export async function changedFiles(
  handle: JobSandboxHandle,
  from: string,
  to: string,
): Promise<ChangedFile[]> {
  return (await diffEntries(handle, from, to)).map(publicFile)
}

/** The changed files with their before and after bodies. */
export async function changedFileDiffs(
  handle: JobSandboxHandle,
  from: string,
  to: string,
): Promise<ChangedFileDiff[]> {
  const entries = await diffEntries(handle, from, to)
  const shas = [
    ...new Set(
      entries
        .filter((entry) => !entry.omitted)
        .flatMap((entry) => [entry.oldSha, entry.newSha])
        .filter((sha) => sha && !ZERO_SHA.test(sha)),
    ),
  ]
  const sizes = new Map<string, number>()
  if (shas.length > 0) {
    const stdout = await gitOk(
      handle,
      'printf "%s\\n" $CTXPIPE_SHAS | git cat-file --batch-check="%(objectname) %(objectsize)"',
      { CTXPIPE_SHAS: shas.join(" ") },
    )
    for (const line of stdout.split("\n")) {
      const [sha, size] = line.split(" ")
      if (sha && size) sizes.set(sha, Number.parseInt(size, 10))
    }
  }
  const blob = async (sha: string) => {
    if (!sha || ZERO_SHA.test(sha)) return null
    return gitOk(handle, 'git cat-file blob "$CTXPIPE_SHA"', {
      CTXPIPE_SHA: sha,
    })
  }
  const diffs: ChangedFileDiff[] = []
  for (const entry of entries) {
    const file = publicFile(entry)
    const tooLarge = [entry.oldSha, entry.newSha].some(
      (sha) => (sizes.get(sha) ?? 0) > DIFF_BODY_LIMIT_BYTES,
    )
    if (file.omitted || tooLarge) {
      diffs.push({
        ...file,
        omitted: file.omitted ?? "too_large",
        oldBody: null,
        body: null,
      })
      continue
    }
    diffs.push({
      ...file,
      oldBody: await blob(entry.oldSha),
      body: await blob(entry.newSha),
    })
  }
  return diffs
}

/**
 * Writes the work tree, with the untracked files that git does not ignore,
 * as a tree object. A copy of the index is used, so the real index and the
 * work tree do not change. Prints the tree, then the conversation base.
 */
const WRITE_WORKTREE_TREE = [
  "idx=$(mktemp) || exit 1",
  "trap 'rm -f \"$idx\"' EXIT",
  "src=$(git rev-parse --git-path index)",
  // git does not accept an empty index file; no file is an empty index.
  'if [ -f "$src" ]; then cp "$src" "$idx"; else rm -f "$idx"; fi',
  'GIT_INDEX_FILE="$idx" git add -A >/dev/null',
  'tree=$(GIT_INDEX_FILE="$idx" git write-tree)',
].join(" && ")

function parseTree(stdout: string): string {
  const tree = stdout.trim().split("\n")[0]?.trim() ?? ""
  if (!/^[0-9a-f]{40,64}$/.test(tree))
    throw new Error("The work tree snapshot did not give a tree")
  return tree
}

/**
 * The conversation's changes against its base: the merge base of the
 * conversation base and HEAD, to the work tree. The label and the bodies use
 * the same base.
 */
export async function conversationBaseDiff(input: {
  handle: JobSandboxHandle
  defaultBranch: string
}): Promise<ChangedFileDiff[]> {
  const stdout = await gitOk(
    input.handle,
    `${WRITE_WORKTREE_TREE} && base=$(git merge-base "${CONVERSATION_BASE}" HEAD 2>/dev/null || git rev-parse HEAD) && printf "%s\\n%s\\n" "$tree" "$base"`,
    { CTXPIPE_DEFAULT_BRANCH: input.defaultBranch },
  )
  const [, base = ""] = stdout.trim().split("\n")
  return changedFileDiffs(input.handle, base.trim(), parseTree(stdout))
}

export type TurnSnapshot = { tree: string; base: string | null }

const TURN_REFS = "refs/ctxpipe/turns"

/** A ref name part for one turn; it sorts by the start time. */
export function turnSnapshotKey(runId: string, startedAt: number): string {
  return `${String(startedAt).padStart(13, "0")}-${runId.replace(/[^A-Za-z0-9_-]/g, "_")}`
}

/**
 * Writes the work tree as a tree object and keeps it under
 * refs/ctxpipe/turns/<key>/<phase>, so garbage collection keeps it. Also
 * gives the conversation base at that time.
 */
export async function snapshotConversationTurn(
  handle: JobSandboxHandle,
  key: string,
  phase: "start" | "end",
): Promise<TurnSnapshot> {
  const stdout = await gitOk(
    handle,
    `${WRITE_WORKTREE_TREE} && git update-ref "${TURN_REFS}/$CTXPIPE_KEY/$CTXPIPE_PHASE" "$tree" && printf "%s\\n%s\\n" "$tree" "$(git rev-parse -q --verify refs/remotes/ctxpipe/base)"`,
    { CTXPIPE_KEY: key, CTXPIPE_PHASE: phase },
  )
  const base = stdout.trim().split("\n")[1]?.trim() || null
  return { tree: parseTree(stdout), base }
}

/** Keeps the snapshot refs of the newest turns and deletes the rest. */
export async function pruneConversationTurnSnapshots(
  handle: JobSandboxHandle,
  keep: number,
): Promise<void> {
  const refs = (
    await gitOk(handle, `git for-each-ref --format='%(refname)' ${TURN_REFS}/`)
  )
    .split("\n")
    .filter(Boolean)
  const keys = [
    ...new Set(refs.map((ref) => ref.split("/").slice(0, -1).join("/"))),
  ]
    .sort()
    .reverse()
  const drop = new Set(keys.slice(keep))
  const lines = refs
    .filter((ref) => drop.has(ref.split("/").slice(0, -1).join("/")))
    .map((ref) => `delete ${ref}\n`)
    .join("")
  if (!lines) return
  await gitOk(handle, 'printf "%s" "$CTXPIPE_LINES" | git update-ref --stdin', {
    CTXPIPE_LINES: lines,
  })
}

/** True when both snapshot trees are still in the sandbox. */
export async function turnSnapshotsExist(
  handle: JobSandboxHandle,
  start: string,
  end: string,
): Promise<boolean> {
  const result = await handle.exec(
    'git cat-file -e "$CTXPIPE_START^{tree}" && git cat-file -e "$CTXPIPE_END^{tree}"',
    { env: { CTXPIPE_START: start, CTXPIPE_END: end } },
  )
  return result.exitCode === 0
}

/**
 * The files the turn changed. When the conversation base moved during the
 * turn (a rebase onto a new default commit), a file that only follows the
 * upstream change is not the turn's change: it is in the upstream diff and
 * it ends equal to the new base.
 */
export async function conversationTurnFiles(
  handle: JobSandboxHandle,
  start: TurnSnapshot,
  end: TurnSnapshot,
): Promise<ChangedFile[]> {
  const files = await changedFiles(handle, start.tree, end.tree)
  if (!start.base || !end.base || start.base === end.base || files.length === 0)
    return files
  const env = {
    CTXPIPE_OLD_BASE: start.base,
    CTXPIPE_NEW_BASE: end.base,
    CTXPIPE_END: end.tree,
  }
  const [upstream, differsFromNewBase] = await Promise.all([
    gitOk(
      handle,
      'git diff --no-ext-diff --no-textconv --name-only --no-renames -z "$CTXPIPE_OLD_BASE" "$CTXPIPE_NEW_BASE"',
      env,
    ),
    gitOk(
      handle,
      'git diff --no-ext-diff --no-textconv --name-only --no-renames -z "$CTXPIPE_NEW_BASE" "$CTXPIPE_END"',
      env,
    ),
  ])
  const upstreamPaths = new Set(splitGitNulPaths(upstream))
  const ownPaths = new Set(splitGitNulPaths(differsFromNewBase))
  return files.filter(
    (file) => !(upstreamPaths.has(file.path) && !ownPaths.has(file.path)),
  )
}
