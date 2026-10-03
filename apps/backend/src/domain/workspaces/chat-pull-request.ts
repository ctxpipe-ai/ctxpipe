import type { JobSandboxHandle } from "./job-worktree.js"

export type ChatPullRequestFile = {
  path: string
  content: string
}

export function splitGitNulPaths(stdout: string): string[] {
  return stdout.split("\0").filter((path) => path.length > 0)
}

export function chatPullRequestPathIsSafe(path: string): boolean {
  if (path.startsWith("/") || path.includes("\0")) return false
  const parts = path.replaceAll("\\", "/").split("/")
  return (
    parts.length > 0 &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  )
}

async function execGit(
  exec: JobSandboxHandle["exec"],
  command: string,
): Promise<string> {
  const result = await exec(command, { env: {} })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `Command failed: ${command}`)
  }
  return result.stdout
}

export function normalizeFindPath(path: string): string {
  return path.replace(/^\.\//, "")
}

export async function collectChatPullRequestTree(
  handle: JobSandboxHandle,
): Promise<{
  files: ChatPullRequestFile[]
  deletePaths: string[]
}> {
  const [modifiedOut, deletedOut, untrackedOut, symlinkOut] = await Promise.all(
    [
      execGit(
        handle.exec,
        "git diff --name-only -z HEAD --diff-filter=ACMRTUXB",
      ),
      execGit(handle.exec, "git diff --name-only -z HEAD --diff-filter=D"),
      execGit(handle.exec, "git ls-files --others --exclude-standard -z"),
      execGit(handle.exec, "find . -type l -print0"),
    ],
  )
  const symlinks = new Set(splitGitNulPaths(symlinkOut).map(normalizeFindPath))
  const filePaths = [
    ...splitGitNulPaths(modifiedOut),
    ...splitGitNulPaths(untrackedOut),
  ]
  const deletePaths = splitGitNulPaths(deletedOut).filter(
    chatPullRequestPathIsSafe,
  )
  const files: ChatPullRequestFile[] = []
  for (const path of filePaths) {
    if (!chatPullRequestPathIsSafe(path) || symlinks.has(path)) {
      throw new Error(`Unsafe path in chat sandbox tree: ${path}`)
    }
    files.push({ path, content: await handle.fs.read(path) })
  }
  return { files, deletePaths }
}

const SESSION_BRANCH = /^ctxpipe\/chat\/[A-Za-z0-9._/-]+$/

export function isChatSessionBranch(branch: string): boolean {
  return SESSION_BRANCH.test(branch) && !branch.includes("..")
}

export async function checkoutPublishedChatBranch(input: {
  handle: JobSandboxHandle
  branch: string
}): Promise<void> {
  if (!isChatSessionBranch(input.branch)) {
    throw new Error(`Refusing to check out ${input.branch}`)
  }
  await execGit(input.handle.exec, `git checkout -B ${input.branch}`)
  await execGit(input.handle.exec, "git add -A")
  const committed = await input.handle.exec(
    "git -c user.email=workspace-chat@ctxpipe.local -c user.name=ctxpipe commit -m workspace-chat-pr",
    { env: {} },
  )
  const output = `${committed.stdout}\n${committed.stderr}`
  if (committed.exitCode !== 0 && !/nothing to commit/i.test(output)) {
    throw new Error(
      committed.stderr || "Failed to mark the chat sandbox published",
    )
  }
}
