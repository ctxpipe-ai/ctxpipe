import { randomUUID } from "node:crypto"
import { lstat, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const queues = new Map<string, Promise<unknown>>()

/**
 * Runs `fn` alone for one shared clone: a fetch, a `worktree add`, and a
 * `worktree remove` of one repository never run at the same time. One
 * codesearch process owns the cache, so a lock in memory is sufficient.
 * Git lock files that a killed process left in the shared clone are removed
 * first; no git command of this clone runs at that time. With `checkoutPath`,
 * the lock files of that worktree are removed too. The locks of other
 * worktrees stay, because an index operation of another key can run a git
 * command in its worktree outside this queue.
 */
export async function withSharedClone<T>(
  sharedPath: string,
  fn: () => Promise<T>,
  checkoutPath?: string,
): Promise<T> {
  const previous = queues.get(sharedPath) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      await removeStaleGitLocks(sharedPath, checkoutPath)
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

async function removeStaleGitLocks(
  sharedPath: string,
  checkoutPath: string | undefined,
): Promise<void> {
  const adminDir = checkoutPath
    ? await worktreeAdminDir(sharedPath, checkoutPath)
    : null
  const locks = [
    join(sharedPath, "index.lock"),
    join(sharedPath, "shallow.lock"),
    join(sharedPath, "config.lock"),
    join(sharedPath, "packed-refs.lock"),
    ...(adminDir
      ? [join(adminDir, "index.lock"), join(adminDir, "HEAD.lock")]
      : []),
  ]
  for (const lock of locks) await rm(lock, { force: true })
}

/**
 * The directory in `<shared>/worktrees/` that holds the git state of the
 * worktree at `checkoutPath`, from the `gitdir:` line of its `.git` file.
 * Gives null when the path is not a worktree of the shared clone.
 */
async function worktreeAdminDir(
  sharedPath: string,
  checkoutPath: string,
): Promise<string | null> {
  const dotGit = await readFile(join(checkoutPath, ".git"), "utf8").catch(
    () => null,
  )
  const gitdir = /^gitdir: (.+)$/m.exec(dotGit ?? "")?.[1]
  if (!gitdir) return null
  const adminDir = await realpathOrSelf(resolve(checkoutPath, gitdir.trim()))
  const worktrees = join(await realpathOrSelf(sharedPath), "worktrees")
  return dirname(adminDir) === worktrees ? adminDir : null
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
 * (an old standalone clone from before the shared clone) is replaced: the
 * new worktree is made at a temporary path beside it, and then renamed into
 * place. Thus a reader can use the old directory until the swap. The cache
 * holds nothing that cannot be made again. Call it inside `withSharedClone`.
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
  // The checkout collection deletes a `.tmp` entry that a crash left.
  const newPath = `${input.checkoutPath}.${randomUUID()}.tmp`
  const oldPath = `${input.checkoutPath}.${randomUUID()}.old.tmp`
  await git(["worktree", "prune"], input.sharedPath)
  await git(
    ["worktree", "add", "--force", "--detach", newPath, input.sha],
    input.sharedPath,
  )
  try {
    await rename(input.checkoutPath, oldPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    })
    await rename(newPath, input.checkoutPath)
    // The shared clone still has the temporary path of the worktree.
    await git(["worktree", "repair", input.checkoutPath], input.sharedPath)
  } catch (error) {
    await rm(newPath, { recursive: true, force: true })
    await git(["worktree", "prune"], input.sharedPath)
    throw error
  } finally {
    await rm(oldPath, { recursive: true, force: true })
  }
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
