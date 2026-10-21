import { createHash } from "node:crypto"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { isRunningSandboxProvider } from "../../models/workspace-sandboxes.js"
import { listSandboxInstances } from "../../models/workspaces.js"
import {
  type ExplorerGitStatusEntry,
  explorerBlobFromContent,
  explorerGitNumstatFromStdout,
  explorerGitStatusFromPorcelain,
  withExplorerGitLineCounts,
} from "./git-explorer.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import { sameWorkspaceBinding, type WorkspaceRevision } from "./revision.js"
import { attachProviderSandbox } from "./sandbox-provider.js"

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
/**
 * The commit this conversation's changes are counted from: the default
 * commit the sandbox builds on. The checkout, the revision update, and the
 * rotation after a merged PR keep `refs/remotes/ctxpipe/base` current; the
 * local default branch can stay behind. An older sandbox without that ref
 * uses the local default branch.
 */
export const CONVERSATION_BASE =
  '$(git rev-parse -q --verify refs/remotes/ctxpipe/base || printf %s "refs/heads/$CTXPIPE_DEFAULT_BRANCH")'

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

function isConversationSandboxHarnessPath(path: string): boolean {
  if (path === "opencode.json" || path.startsWith("opencode.json/")) return true
  if (path.startsWith(".tanstack-projected-")) return true
  if (path.includes("/.tanstack-projected-")) return true
  if (path === "tm" || path.startsWith("tm/")) return true
  if (path.startsWith("tmp/tanstack-ai-")) return true
  return false
}

export function isConversationSandboxListedPath(path: string): boolean {
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

/**
 * The running sandbox of a conversation whose lock another holder has (a
 * turn, the idle sweep, a publish), for a Files read. This attach changes
 * nothing: it does no setup, sets no secrets, changes no firewall or token,
 * updates no sandbox record, and never starts or resumes a sandbox. Null when
 * no live sandbox runs.
 */
export async function attachTurnSandboxForRead(input: {
  orgId: string
  conversationId: string
  signal?: AbortSignal
}): Promise<JobSandboxHandle | null> {
  const rows = await listSandboxInstances({
    conversationId: input.conversationId,
    kind: "chat",
  })
  // The lock holder can be the idle sweep: a stopped row is not read. The
  // turn's own ensure gave its row the latest heartbeat.
  const row = rows
    .filter((item) => item.state === "live" && item.providerSandboxId)
    .sort(
      (a, b) => b.lastHeartbeatAt.getTime() - a.lastHeartbeatAt.getTime(),
    )[0]
  if (!row?.providerSandboxId) return null
  const sandbox =
    row.provider === "local-process"
      ? await localProcessSandbox().resume({ id: row.providerSandboxId })
      : isRunningSandboxProvider(row.provider)
        ? await attachProviderSandbox({
            orgId: input.orgId,
            provider: row.provider,
            providerSandboxId: row.providerSandboxId,
            onlyRunning: true,
            signal: input.signal,
          })
        : null
  return sandbox ? adaptTanstackHandle(sandbox, input.signal) : null
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
    execGitOk(handle.exec, "git diff --no-ext-diff --no-textconv HEAD"),
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

/**
 * A write, a rename, or a delete changes only the worktree files: the same
 * rule as the read, without the tree list, so that a new file is possible.
 * The path must not be in git metadata (a `.git` part at any depth), and no
 * part of it that exists can be a symlink.
 */
/** A client-supplied path that the conversation worktree must not touch. */
export class UnsafeConversationPathError extends Error {}

async function assertConversationPathWritable(
  handle: JobSandboxHandle,
  path: string,
): Promise<void> {
  const inGitMetadata = path
    .split("/")
    .some((part) => part.toLowerCase() === ".git")
  if (conversationPathIsSafe(path) && !inGitMetadata) {
    const checked = await execGit(handle.exec, `${STOP_AT_SYMLINK}printf ok`, {
      CTXPIPE_FILE_PATH: path,
    })
    if (checked.exitCode === 0 && checked.stdout === "ok") return
  }
  throw new UnsafeConversationPathError(`Unsafe path: ${path}`)
}

export async function writeConversationSandboxFile(input: {
  handle: JobSandboxHandle
  path: string
  body: string
}): Promise<void> {
  await assertConversationPathWritable(input.handle, input.path)
  const parent = input.path.split("/").slice(0, -1).join("/")
  // The Docker and Vercel handles build `mkdir -p` and the write from the
  // path: without a slash before the name, `mkdir -p` makes a directory with
  // the file's name, and a leading "-" reads as an option. "./" stops both.
  if (parent) await input.handle.fs.mkdir(`./${parent}`)
  await input.handle.fs.write(`./${input.path}`, input.body)
}

export async function removeConversationSandboxPath(input: {
  handle: JobSandboxHandle
  path: string
}): Promise<void> {
  await assertConversationPathWritable(input.handle, input.path)
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
    throw new UnsafeConversationPathError(
      `Unsafe path: ${input.from} → ${input.to}`,
    )
  }
  if (input.from === input.to) return
  await assertConversationPathWritable(input.handle, input.from)
  await assertConversationPathWritable(input.handle, input.to)
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

type ConversationSandboxStatus = {
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
    againstBase,
  ] = await Promise.all([
    execGitOk(
      input.handle.exec,
      "git status --porcelain --untracked-files=all",
    ),
    execGitOk(
      input.handle.exec,
      "git diff --no-ext-diff --no-textconv --numstat HEAD",
    ),
    execGit(
      input.handle.exec,
      `git rev-list --left-right --count "${CONVERSATION_BASE}...HEAD"`,
      { CTXPIPE_DEFAULT_BRANCH: input.defaultBranch },
    ),
    execGit(
      input.handle.exec,
      'git rev-parse -q --verify "refs/remotes/origin/$CTXPIPE_SESSION_BRANCH"',
      { CTXPIPE_SESSION_BRANCH: input.sessionBranch },
    ),
    execGitOk(input.handle.exec, UNPUSHED_COMMITS_COMMAND),
    execGitOk(input.handle.exec, "git branch --show-current"),
    // Tracked files that differ from the base, committed or not. Without a
    // base branch, compare with HEAD.
    execGitOk(
      input.handle.exec,
      `base=$(git merge-base "${CONVERSATION_BASE}" HEAD 2>/dev/null || git rev-parse HEAD) && git diff --no-ext-diff --no-textconv --no-renames --name-status --diff-filter=ADM -z "$base"`,
      { CTXPIPE_DEFAULT_BRANCH: input.defaultBranch },
    ),
  ])
  const branch = currentBranch.trim()
  if (!branch) throw new Error("Conversation worktree has no current branch")
  const counts = explorerGitNumstatFromStdout(numstat)
  const byPath = new Map<string, ExplorerGitStatusEntry>()
  const fields = splitGitNulPaths(againstBase)
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index + 1] ?? ""
    const code = fields[index]
    const status =
      code === "A" ? "added" : code === "D" ? "deleted" : "modified"
    byPath.set(path, { path, status })
  }
  // An untracked file is new against the base, unless the base has a file
  // at that path. Then it is modified, also when the content is the same.
  for (const item of explorerGitStatusFromPorcelain(porcelain)) {
    if (item.status !== "untracked") continue
    const status = byPath.has(item.path) ? "modified" : "added"
    byPath.set(item.path, { path: item.path, status })
  }
  const items = [...byPath.values()]
    .filter((item) => isConversationSandboxListedPath(item.path))
    .map((item) => withExplorerGitLineCounts(item, counts))
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

/**
 * The revision fields of a conversation's Git status. `stale`: the sandbox is
 * not on the Workspace's current commit. A conversation with no changes of
 * its own moves to that commit at the start of its next turn, so it needs no
 * notice. `workspaceMovedUnderChanges` is true only when the sandbox is stale
 * and the conversation has its own changes. No merge check runs here, so this
 * status never reports a conflict.
 */
export function conversationRevisionStatus(input: {
  sha: string | null
  desiredSha: string | null
  differsFromDefault: boolean
  unpushed: boolean
}) {
  const stale = input.sha !== input.desiredSha
  return {
    sha: input.sha,
    desiredSha: input.desiredSha,
    stale,
    workspaceMovedUnderChanges:
      stale && (input.differsFromDefault || input.unpushed),
  }
}

export function sanitizeGitRemoteError(text: string, token: string): string {
  return token ? text.split(token).join("***") : text
}
