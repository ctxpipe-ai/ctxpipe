import { createHash } from "node:crypto"
import { listSandboxInstances } from "../../models/workspaces.js"
import { conversationSessionBranch } from "./chat-lifecycle.js"
import {
  type ExplorerGitStatusEntry,
  explorerBlobFromContent,
  explorerGitNumstatFromStdout,
  explorerGitStatusFromPorcelain,
  withExplorerGitLineCounts,
} from "./git-explorer.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import { sameWorkspaceBinding, type WorkspaceRevision } from "./revision.js"

export { conversationSessionBranch }

export function splitGitNulPaths(stdout: string): string[] {
  return stdout.split("\0").filter((path) => path.length > 0)
}

/**
 * Commits GitHub lacks: commits on HEAD or on a local branch that no
 * remote-tracking ref reaches. The session branch counts also when HEAD is on
 * the default branch. `refs/remotes/ctxpipe/base` marks the default commit
 * the sandbox builds on. Prints one commit, or nothing. The Files status, the
 * push and the deletion sweep all use this test.
 */
export const UNPUSHED_COMMITS_COMMAND =
  "git rev-list -n 1 HEAD --branches --not --remotes"

/** A relative path inside the conversation worktree, never escaping it. */
export function conversationPathIsSafe(path: string): boolean {
  if (path.startsWith("/") || path.includes("\0")) return false
  const parts = path.replaceAll("\\", "/").split("/")
  return (
    parts.length > 0 &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  )
}

/** Harness writes that must stay out of the git workdir listing and publish. */
export const CONVERSATION_SANDBOX_GIT_EXCLUDE_LINES = [
  "opencode.json",
  ".tanstack-projected-*",
  "tm/",
  "tmp/tanstack-ai-*",
] as const

export function isConversationSandboxHarnessPath(path: string): boolean {
  if (path === "opencode.json" || path.startsWith("opencode.json/")) return true
  if (path.startsWith(".tanstack-projected-")) return true
  if (path.includes("/.tanstack-projected-")) return true
  if (path === "tm" || path.startsWith("tm/")) return true
  if (path.startsWith("tmp/tanstack-ai-")) return true
  return false
}

function isConversationSandboxListedPath(path: string): boolean {
  return conversationPathIsSafe(path) && !isConversationSandboxHarnessPath(path)
}

export async function getConversationSandboxBinding(
  conversationId: string,
  expected: WorkspaceRevision,
) {
  const rows = await listSandboxInstances({ conversationId, kind: "chat" })
  // An idle-stopped sandbox keeps its files; reading them resumes it.
  const available = rows.filter(
    (row) =>
      row.state !== "destroy_failed" && row.providerSandboxId && row.revision,
  )
  const matching = available.find(
    (row) =>
      row.revision &&
      sameWorkspaceBinding(row.revision, expected) &&
      row.revision.sha === expected.sha,
  )
  // A nonmatching row is used only to report the precise stale-binding reason.
  // A valid current revision always wins, regardless of another run's heartbeat.
  const revision = (
    matching ??
    available.sort(
      (a, b) => b.lastHeartbeatAt.getTime() - a.lastHeartbeatAt.getTime(),
    )[0]
  )?.revision
  return revision
    ? {
        githubConnectionId: revision.remote.connectionId,
        defaultBranch: revision.defaultBranch,
        desiredGeneration: revision.generation,
        desiredUrl: revision.remote.url,
        desiredSha: revision.sha,
      }
    : null
}

async function execGit(
  exec: JobSandboxHandle["exec"],
  command: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return env ? exec(command, { env }) : exec(command)
}

async function execGitOk(
  exec: JobSandboxHandle["exec"],
  command: string,
  env?: Record<string, string>,
): Promise<string> {
  const result = await execGit(exec, command, env)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Command failed: ${command}`)
  }
  return result.stdout
}

/** Lists the tracked files and the untracked files that git does not ignore. */
const LIST_TREE_FILES_COMMAND =
  "git ls-files -z --cached --others --exclude-standard"

/**
 * Shell prefix that stops with no output when a component of
 * $CTXPIPE_FILE_PATH is a symlink. Git lists a symlink as a file, and it
 * keeps an index path when a parent directory becomes a symlink.
 */
const STOP_AT_SYMLINK =
  'set -f; p=; s=; IFS=/; for part in $CTXPIPE_FILE_PATH; do p="$p$s$part"; s=/; if [ -L "$p" ]; then exit 0; fi; done; unset IFS; '

export async function listConversationSandboxPaths(
  handle: JobSandboxHandle,
): Promise<string[]> {
  const listed = await execGitOk(handle.exec, LIST_TREE_FILES_COMMAND)
  return [...new Set(splitGitNulPaths(listed))]
    .filter(isConversationSandboxListedPath)
    .sort()
}

export async function readConversationSandboxFile(
  handle: JobSandboxHandle,
  path: string,
): Promise<{ path: string; body: string | null; binary: boolean } | null> {
  // Read only a path that the tree lists, with no symlink. This prevents a
  // read of .git and of ignored files, such as .env.
  return readSandboxFileIfListed(
    handle,
    path,
    `${LIST_TREE_FILES_COMMAND} -- ":(literal)$CTXPIPE_FILE_PATH"`,
  )
}

/**
 * Reads a path when `listCommand` prints it after the symlink check. The
 * diff checks the tree list before the call, so its command only prints the
 * path.
 */
async function readSandboxFileIfListed(
  handle: JobSandboxHandle,
  path: string,
  listCommand: string,
): Promise<{ path: string; body: string | null; binary: boolean } | null> {
  if (!isConversationSandboxListedPath(path)) return null
  const listed = await execGitOk(
    handle.exec,
    `${STOP_AT_SYMLINK}${listCommand}`,
    { CTXPIPE_FILE_PATH: path },
  )
  if (!splitGitNulPaths(listed).includes(path)) return null
  try {
    const content = await handle.fs.read(path)
    const blob = explorerBlobFromContent(content)
    if (!blob) return null
    return { path, ...blob }
  } catch (error) {
    if (isMissingFileError(error)) return null
    const exists = await handle.exec('test -e "$CTXPIPE_FILE_PATH"', {
      env: { CTXPIPE_FILE_PATH: path },
    })
    if (exists.exitCode === 1) return null
    throw error
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  )
}

export function fingerprintConversationWorktree(input: {
  headSha: string
  trackedDiff: string
  untracked: Array<{ path: string; digest: string }>
}): string {
  const hash = createHash("sha256")
  hash.update(`${input.headSha.trim()}\n`)
  hash.update(input.trackedDiff)
  hash.update("\n")
  for (const file of [...input.untracked].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    hash.update(file.path)
    hash.update("\0")
    hash.update(file.digest)
    hash.update("\n")
  }
  return hash.digest("hex")
}

export async function conversationWorktreeVersion(
  handle: JobSandboxHandle,
): Promise<string> {
  const [head, trackedDiff, untrackedRaw] = await Promise.all([
    execGitOk(handle.exec, "git rev-parse HEAD"),
    execGitOk(handle.exec, "git diff HEAD"),
    execGitOk(handle.exec, "git ls-files --others --exclude-standard -z"),
  ])
  const untracked: Array<{ path: string; digest: string }> = []
  for (const path of splitGitNulPaths(untrackedRaw)) {
    if (!isConversationSandboxListedPath(path)) continue
    try {
      const digest = createHash("sha256")
      digest.update(await handle.fs.read(path))
      untracked.push({ path, digest: digest.digest("hex") })
    } catch {
      throw new Error(`Failed to read untracked worktree file: ${path}`)
    }
  }
  return fingerprintConversationWorktree({
    headSha: head,
    trackedDiff,
    untracked,
  })
}

export async function writeConversationSandboxFile(input: {
  handle: JobSandboxHandle
  path: string
  body: string
}): Promise<void> {
  if (!conversationPathIsSafe(input.path)) {
    throw new Error(`Unsafe path: ${input.path}`)
  }
  const parent = input.path.split("/").slice(0, -1).join("/")
  if (parent) await input.handle.fs.mkdir(parent)
  await input.handle.fs.write(input.path, input.body)
}

export async function removeConversationSandboxPath(input: {
  handle: JobSandboxHandle
  path: string
}): Promise<void> {
  if (!conversationPathIsSafe(input.path)) {
    throw new Error(`Unsafe path: ${input.path}`)
  }
  await input.handle.fs.remove(input.path)
}

export async function renameConversationSandboxPath(input: {
  handle: JobSandboxHandle
  from: string
  to: string
}): Promise<void> {
  if (
    !conversationPathIsSafe(input.from) ||
    !conversationPathIsSafe(input.to)
  ) {
    throw new Error(`Unsafe path: ${input.from} → ${input.to}`)
  }
  if (input.from === input.to) return
  const paths = await listConversationSandboxPaths(input.handle)
  const matches = paths.filter(
    (path) => path === input.from || path.startsWith(`${input.from}/`),
  )
  if (matches.length === 0) return
  for (const oldPath of matches) {
    const next =
      oldPath === input.from
        ? input.to
        : `${input.to}/${oldPath.slice(input.from.length + 1)}`
    const parent = next.split("/").slice(0, -1).join("/")
    if (parent) await input.handle.fs.mkdir(parent)
    await execGitOk(
      input.handle.exec,
      'if [ -d "$CTXPIPE_RENAME_TO" ]; then printf \'destination is a directory\\n\' >&2; exit 1; fi; mv -f -- "$CTXPIPE_RENAME_FROM" "$CTXPIPE_RENAME_TO"',
      {
        CTXPIPE_RENAME_FROM: oldPath,
        CTXPIPE_RENAME_TO: next,
      },
    )
  }
}

export type ConversationSandboxStatus = {
  branch: string
  dirty: boolean
  differsFromDefault: boolean
  unpushed: boolean
  published: boolean
  ahead: number
  behind: number
  items: ExplorerGitStatusEntry[]
}

export async function conversationSandboxStatus(input: {
  handle: JobSandboxHandle
  defaultBranch: string
  sessionBranch: string
}): Promise<ConversationSandboxStatus> {
  const [
    porcelain,
    numstat,
    revList,
    remoteSession,
    unpushed,
    currentBranch,
    committed,
    listed,
  ] = await Promise.all([
    execGitOk(input.handle.exec, "git status --porcelain"),
    execGitOk(input.handle.exec, "git diff --numstat HEAD"),
    execGit(
      input.handle.exec,
      'git rev-list --left-right --count "refs/heads/$CTXPIPE_DEFAULT_BRANCH"...HEAD',
      { CTXPIPE_DEFAULT_BRANCH: input.defaultBranch },
    ),
    execGit(
      input.handle.exec,
      'git rev-parse -q --verify "refs/remotes/origin/$CTXPIPE_SESSION_BRANCH"',
      { CTXPIPE_SESSION_BRANCH: input.sessionBranch },
    ),
    execGitOk(input.handle.exec, UNPUSHED_COMMITS_COMMAND),
    execGitOk(input.handle.exec, "git branch --show-current"),
    // Files this conversation changed in its own commits, against its base.
    execGit(
      input.handle.exec,
      'git diff --no-renames --name-status --diff-filter=ADM -z "refs/heads/$CTXPIPE_DEFAULT_BRANCH"...HEAD',
      { CTXPIPE_DEFAULT_BRANCH: input.defaultBranch },
    ),
    execGitOk(
      input.handle.exec,
      "git ls-files --cached --others --exclude-standard -z",
    ),
  ])
  const branch = currentBranch.trim()
  if (!branch) throw new Error("Conversation worktree has no current branch")
  const counts = explorerGitNumstatFromStdout(numstat)
  const items = explorerGitStatusFromPorcelain(porcelain)
    .filter((item) => isConversationSandboxListedPath(item.path))
    .map((item) => withExplorerGitLineCounts(item, counts))
  // A committed change leaves `git status`; keep it until the base has it.
  const listedPaths = new Set(splitGitNulPaths(listed))
  const fields = splitGitNulPaths(
    committed.exitCode === 0 ? committed.stdout : "",
  )
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const code = fields[index]
    const path = fields[index + 1]
    if (!path || !isConversationSandboxListedPath(path)) continue
    const current = items.findIndex((item) => item.path === path)
    if (code === "D") {
      if (current >= 0 || listedPaths.has(path)) continue
      items.push({ path, status: "deleted", additions: 0 })
      continue
    }
    if (current < 0) {
      if (listedPaths.has(path)) {
        items.push({ path, status: code === "A" ? "added" : "modified" })
      }
      continue
    }
    // Against the base, a file this conversation added is still added after
    // a later edit, and is gone (not deleted) after a later removal.
    if (code !== "A") continue
    if (items[current]?.status === "deleted") items.splice(current, 1)
    else if (items[current]) items[current].status = "added"
  }
  const dirty = porcelain.trim().length > 0
  const [behindRaw, aheadRaw] = (revList.stdout.trim() || "0\t0").split(/\s+/)
  const ahead = Number.parseInt(aheadRaw || "0", 10) || 0
  const behind = Number.parseInt(behindRaw || "0", 10) || 0
  const published =
    branch === input.sessionBranch && remoteSession.exitCode === 0
  return {
    branch,
    dirty,
    differsFromDefault: dirty || ahead > 0,
    // The same test the broker uses before a push.
    unpushed: dirty || unpushed.trim().length > 0,
    published,
    ahead,
    behind,
    items,
  }
}

export type ConversationFileDiff = {
  path: string
  oldBody: string | null
  body: string | null
}

export async function conversationSandboxDiff(input: {
  handle: JobSandboxHandle
  defaultBranch: string
}): Promise<ConversationFileDiff[]> {
  const [committed, unstaged, untracked, listed] = await Promise.all([
    execGitOk(
      input.handle.exec,
      'git diff --name-only -z "refs/heads/$CTXPIPE_DEFAULT_BRANCH"...HEAD',
      { CTXPIPE_DEFAULT_BRANCH: input.defaultBranch },
    ),
    execGitOk(input.handle.exec, "git diff --name-only -z HEAD"),
    execGitOk(input.handle.exec, "git ls-files --others --exclude-standard -z"),
    execGitOk(input.handle.exec, LIST_TREE_FILES_COMMAND),
  ])
  // A diff can name a path that git now ignores and does not track, such as
  // a local .env. Read the current body only of a path that the tree lists.
  const treePaths = new Set(splitGitNulPaths(listed))
  const paths = new Set<string>()
  for (const path of [
    ...splitGitNulPaths(committed),
    ...splitGitNulPaths(unstaged),
    ...splitGitNulPaths(untracked),
  ]) {
    if (isConversationSandboxListedPath(path)) paths.add(path)
  }
  const diffs: ConversationFileDiff[] = []
  for (const path of [...paths].sort()) {
    const oldResult = await execGit(
      input.handle.exec,
      'git show "refs/heads/$CTXPIPE_DEFAULT_BRANCH:$CTXPIPE_FILE_PATH"',
      {
        CTXPIPE_DEFAULT_BRANCH: input.defaultBranch,
        CTXPIPE_FILE_PATH: path,
      },
    )
    const oldBody = oldResult.exitCode === 0 ? oldResult.stdout : null
    const current = treePaths.has(path)
      ? await readSandboxFileIfListed(
          input.handle,
          path,
          "printf '%s\\0' \"$CTXPIPE_FILE_PATH\"",
        )
      : null
    diffs.push({
      path,
      oldBody,
      body: current?.binary ? null : (current?.body ?? null),
    })
  }
  return diffs
}

export function sanitizeGitRemoteError(text: string, token: string): string {
  return token ? text.split(token).join("***") : text
}
