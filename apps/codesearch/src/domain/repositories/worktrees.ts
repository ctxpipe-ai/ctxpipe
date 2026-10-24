import { lstat, readdir, realpath, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { REPO_CACHE_DIR } from "../../config/paths.js"

/**
 * Each repository has one shared bare clone. Each checkout key is a git
 * worktree of that clone at `checkouts/<key>`, so the readers (Zoekt, SCIP,
 * file reads) keep their paths. Only the shared clone fetches, deepens, or
 * unshallows.
 */
export function repoSharedClonePath(orgId: string, repoId: string): string {
  return `${REPO_CACHE_DIR}/${orgId}/${repoId}/shared.git`
}

const queues = new Map<string, Promise<unknown>>()

/**
 * Runs `fn` alone for one shared clone: a fetch, a `worktree add`, and a
 * `worktree remove` of one repository never run at the same time. One
 * codesearch process owns the cache, so a lock in memory is sufficient.
 * Git lock files that a killed process left are removed first; no git
 * command of this clone runs at that time.
 */
export async function withSharedClone<T>(
  sharedPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(sharedPath) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      await removeStaleGitLocks(sharedPath)
      return fn()
    })
  const tail = run.catch(() => undefined)
  queues.set(sharedPath, tail)
  try {
    return await run
  } finally {
    if (queues.get(sharedPath) === tail) queues.delete(sharedPath)
  }
}

async function removeStaleGitLocks(sharedPath: string): Promise<void> {
  const worktrees = await readdir(join(sharedPath, "worktrees")).catch(
    () => [] as string[],
  )
  const locks = [
    join(sharedPath, "index.lock"),
    join(sharedPath, "shallow.lock"),
    join(sharedPath, "config.lock"),
    join(sharedPath, "packed-refs.lock"),
    ...worktrees.flatMap((name) => [
      join(sharedPath, "worktrees", name, "index.lock"),
      join(sharedPath, "worktrees", name, "HEAD.lock"),
    ]),
  ]
  for (const lock of locks) await rm(lock, { force: true })
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // A worktree command never asks for a credential or reads a remote.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd)
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args[0]} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
    )
  return result.stdout
}

/** True when `checkoutPath` is a worktree of `sharedPath` (its `.git` is a file). */
async function isWorktreeOf(
  sharedPath: string,
  checkoutPath: string,
): Promise<boolean> {
  const dotGit = await lstat(join(checkoutPath, ".git")).catch(() => null)
  if (!dotGit?.isFile()) return false
  const result = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    checkoutPath,
  )
  if (result.exitCode !== 0) return false
  const [common, shared] = await Promise.all([
    realpathOrSelf(result.stdout.trim()),
    realpathOrSelf(sharedPath),
  ])
  return common === shared
}

async function realpathOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

/**
 * Makes `checkoutPath` a detached worktree of the shared clone at `sha`.
 * A worktree that exists is moved to `sha`. Any other directory at the path
 * (an old standalone clone from before the shared clone) is deleted first;
 * the cache holds nothing that cannot be made again. Call it inside
 * `withSharedClone`.
 */
export async function ensureCheckoutWorktree(input: {
  sharedPath: string
  checkoutPath: string
  sha: string
}): Promise<void> {
  if (await isWorktreeOf(input.sharedPath, input.checkoutPath)) {
    await git(
      ["checkout", "--force", "--detach", input.sha],
      input.checkoutPath,
    )
    return
  }
  await rm(input.checkoutPath, { recursive: true, force: true })
  await git(["worktree", "prune"], input.sharedPath)
  await git(
    ["worktree", "add", "--force", "--detach", input.checkoutPath, input.sha],
    input.sharedPath,
  )
}

/**
 * Deletes the worktree at `checkoutPath` and its registration in the shared
 * clone. A path that is not a worktree is deleted as a plain directory. Call
 * it inside `withSharedClone`.
 */
export async function removeCheckoutWorktree(input: {
  sharedPath: string
  checkoutPath: string
}): Promise<void> {
  if (await isWorktreeOf(input.sharedPath, input.checkoutPath)) {
    const removed = await runGit(
      ["worktree", "remove", "--force", "--force", input.checkoutPath],
      input.sharedPath,
    )
    if (removed.exitCode === 0) return
  }
  await rm(input.checkoutPath, { recursive: true, force: true })
  if (await pathExists(input.sharedPath))
    await git(["worktree", "prune"], input.sharedPath)
}

/** Drops the registrations of worktrees whose directory is gone. */
export async function pruneWorktrees(sharedPath: string): Promise<void> {
  if (await pathExists(sharedPath)) await git(["worktree", "prune"], sharedPath)
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}
