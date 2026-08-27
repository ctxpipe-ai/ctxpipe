import {
  conversationSessionBranch,
  mayForcePushBranch,
} from "./chat-lifecycle.js"
import {
  chatPullRequestPathIsSafe,
  isChatSessionBranch,
  splitGitNulPaths,
} from "./chat-pull-request.js"
import {
  type ExplorerGitStatusEntry,
  explorerBlobFromContent,
  explorerGitNumstatFromStdout,
  explorerGitStatusFromPorcelain,
  withExplorerGitLineCounts,
} from "./git-explorer.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import { getRegisteredChatSandbox } from "./sandbox-registry.js"
import { memoizedConversationSandboxHandle } from "./workspace-chat-sandbox-memo.js"

export { conversationSessionBranch }

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
  return chatPullRequestPathIsSafe(path) && !isConversationSandboxHarnessPath(path)
}

export function resolveConversationSandboxHandle(
  conversationId: string,
): JobSandboxHandle | null {
  const registered = getRegisteredChatSandbox(conversationId)?.handle
  if (registered) return registered
  const raw = memoizedConversationSandboxHandle(conversationId)
  return raw ? adaptTanstackHandle(raw) : null
}

const conversationSandboxTreeAttachFlights = new Map<
  string,
  Promise<JobSandboxHandle | null>
>()

export function resetConversationSandboxTreeAttachFlights(): void {
  conversationSandboxTreeAttachFlights.clear()
}

export async function resolveConversationSandboxForTree(input: {
  conversationId: string
  attach: boolean
  warm: () => Promise<JobSandboxHandle | null>
  resolve?: (conversationId: string) => JobSandboxHandle | null
}): Promise<JobSandboxHandle | null> {
  const resolve = input.resolve ?? resolveConversationSandboxHandle
  const existing = resolve(input.conversationId)
  if (existing) return existing
  if (!input.attach) return null
  const inflight = conversationSandboxTreeAttachFlights.get(input.conversationId)
  if (inflight) return inflight
  const flight = input.warm().finally(() => {
    conversationSandboxTreeAttachFlights.delete(input.conversationId)
  })
  conversationSandboxTreeAttachFlights.set(input.conversationId, flight)
  return flight
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

export async function ensureConversationSessionBranch(input: {
  handle: JobSandboxHandle
  conversationId: string
  defaultBranch: string
}): Promise<string> {
  const branch = conversationSessionBranch(input.conversationId)
  if (!mayForcePushBranch(branch, input.defaultBranch)) {
    throw new Error(`Refusing to check out ${branch}`)
  }
  if (!isChatSessionBranch(branch)) {
    throw new Error(`Refusing to check out ${branch}`)
  }
  const current = await execGit(input.handle.exec, "git branch --show-current")
  if (current.exitCode === 0 && current.stdout.trim() === branch) {
    return branch
  }
  await execGitOk(input.handle.exec, `git checkout -B ${branch}`)
  return branch
}

export async function listConversationSandboxPaths(
  handle: JobSandboxHandle,
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    execGitOk(handle.exec, "git ls-files -z"),
    execGitOk(handle.exec, "git ls-files --others --exclude-standard -z"),
  ])
  const paths = new Set<string>()
  for (const path of [
    ...splitGitNulPaths(tracked),
    ...splitGitNulPaths(untracked),
  ]) {
    if (isConversationSandboxListedPath(path)) paths.add(path)
  }
  return [...paths].sort()
}

export async function readConversationSandboxFile(
  handle: JobSandboxHandle,
  path: string,
): Promise<{ path: string; body: string | null; binary: boolean } | null> {
  if (!chatPullRequestPathIsSafe(path)) return null
  try {
    const content = await handle.fs.read(path)
    const blob = explorerBlobFromContent(content)
    if (!blob) return null
    return { path, ...blob }
  } catch {
    return null
  }
}

export async function writeConversationSandboxFile(input: {
  handle: JobSandboxHandle
  path: string
  body: string
}): Promise<void> {
  if (!chatPullRequestPathIsSafe(input.path)) {
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
  if (!chatPullRequestPathIsSafe(input.path)) {
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
    !chatPullRequestPathIsSafe(input.from) ||
    !chatPullRequestPathIsSafe(input.to)
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
    const current = await readConversationSandboxFile(input.handle, oldPath)
    if (current?.body != null) {
      await writeConversationSandboxFile({
        handle: input.handle,
        path: next,
        body: current.body,
      })
    }
    await removeConversationSandboxPath({
      handle: input.handle,
      path: oldPath,
    })
  }
}

export type ConversationSandboxStatus = {
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
  const [porcelain, numstat, revList, remoteAhead] = await Promise.all([
    execGitOk(input.handle.exec, "git status --porcelain"),
    execGitOk(input.handle.exec, "git diff --numstat HEAD"),
    execGit(
      input.handle.exec,
      `git rev-list --left-right --count ${input.defaultBranch}...HEAD`,
    ),
    execGit(
      input.handle.exec,
      `git rev-list --count origin/${input.sessionBranch}..HEAD`,
    ),
  ])
  const counts = explorerGitNumstatFromStdout(numstat)
  const items = explorerGitStatusFromPorcelain(porcelain)
    .filter((item) => isConversationSandboxListedPath(item.path))
    .map((item) => withExplorerGitLineCounts(item, counts))
  const dirty = porcelain.trim().length > 0
  const [behindRaw, aheadRaw] = (revList.stdout.trim() || "0\t0").split(/\s+/)
  const ahead = Number.parseInt(aheadRaw || "0", 10) || 0
  const behind = Number.parseInt(behindRaw || "0", 10) || 0
  const published = remoteAhead.exitCode === 0
  const remoteUnpushed = published
    ? (Number.parseInt(remoteAhead.stdout.trim() || "0", 10) || 0) > 0
    : ahead > 0
  return {
    dirty,
    differsFromDefault: dirty || ahead > 0,
    unpushed: dirty || remoteUnpushed,
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
  const [committed, unstaged, untracked] = await Promise.all([
    execGitOk(
      input.handle.exec,
      `git diff --name-only -z ${input.defaultBranch}...HEAD`,
    ),
    execGitOk(input.handle.exec, "git diff --name-only -z HEAD"),
    execGitOk(input.handle.exec, "git ls-files --others --exclude-standard -z"),
  ])
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
      `git show ${input.defaultBranch}:${path}`,
    )
    const oldBody = oldResult.exitCode === 0 ? oldResult.stdout : null
    const current = await readConversationSandboxFile(input.handle, path)
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
