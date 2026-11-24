import { createHash } from "node:crypto"
import { createReadStream, rmSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"

import { trace } from "@opentelemetry/api"

import { log } from "../../observability/logger.js"
import { gitRemoteEnvironment, isRegularFile } from "./clone-tree.js"
import { measuredGitFetch } from "./fetch-bytes.js"
import { startGitProcess } from "./git-process.js"
import { withGitProcessSlot } from "./process-slot.js"

/**
 * Native Git processes that have not exited, by repository directory. The
 * clean-up of a temporary directory waits for them: a process that still
 * writes into the directory makes the removal fail with ENOTEMPTY.
 */
const running = new Map<
  string,
  Set<{ kill: () => void; done: Promise<void> }>
>()

/**
 * Temporary directories whose clean-up has started. A read that was in the
 * slot queue must not start Git in such a directory: the kill of a sibling
 * gives it a slot while the removal runs.
 */
const closing = new Set<string>()

/** Native Git calls that have not settled, also the calls in the slot queue. */
const pending = new Map<string, Set<Promise<void>>>()

/**
 * Native pack and shallow boundary; no filesystem locator or credential is
 * durable. `root` is the Workspace root folder (CTX-709): the read and write
 * helpers use paths relative to it and never touch a path outside it.
 */
export type GitPack = {
  sha: string
  objects: string
  shallow: string
  root?: string
  /**
   * The commits that each step fetches again from the Git host (CTX-955).
   * With a base, `objects` holds only the objects that the base does not
   * have, so a durable step output does not carry the pack of the base. A
   * pack without a base (the shape before CTX-955) holds all its objects.
   */
  base?: GitPackBase
}

/** Immutable commits on a remote. No credential is durable. */
export type GitPackBase = {
  url: string
  shas: string[]
  /**
   * The history depth of each fetched commit (default 1). A write commit is
   * fetched with its parent (2): a push from a commit with a shallow parent
   * link is not a fast-forward for Git.
   */
  depth?: number
}

/**
 * A commit that a Workspace write step made and pushed to its job ref
 * (`refs/ctxpipe/write/<jobId>/<sha>`, CTX-1235). A durable step output
 * holds only this identity, never a Git object: each later step fetches the
 * commit from the Git host again. `base` is the parent of the commit; an
 * unborn bootstrap commit has no parent.
 */
export type GitWriteCommit = {
  sha: string
  tree: string
  root?: string
  base: string | null
}

/**
 * Push the commit `sha` in `directory` to the Git host before the directory
 * goes away. The caller owns the credential and the ref name.
 */
export type PublishGitCommit = (directory: string, sha: string) => Promise<void>

/** The pack, with no objects, that reads a write commit and its parent from `url`. */
export function writeCommitPack(commit: GitWriteCommit, url: string): GitPack {
  return {
    sha: commit.sha,
    objects: "",
    shallow: "",
    ...(commit.root ? { root: commit.root } : {}),
    base: { url, shas: [commit.sha], depth: commit.base ? 2 : 1 },
  }
}

/**
 * Transient read access to the repository that a Workspace is bound to. The
 * domain layer makes it from the workflow input, not from a step output, and
 * gives it to each Git operation as an argument. It is never in a step
 * output.
 */
export type GitRemoteRead = {
  url: string
  token: () => Promise<string | undefined>
}

/**
 * The base of a stored pack must be the bound repository, on github.com over
 * HTTPS (Workspace writes require a github.com remote). The check comes
 * before the token: a stored step output cannot send a credential to
 * another host or to another repository.
 */
function assertBaseOfBoundRepository(base: GitPackBase, read: GitRemoteRead) {
  const url = URL.canParse(base.url) ? new URL(base.url) : null
  if (
    base.url !== read.url ||
    url?.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port !== "" ||
    base.url.includes("\\")
  )
    throw new Error(
      "The stored Git pack names a remote that is not the GitHub repository of its Workspace",
    )
}

/** A Git host error that can go away when the fetch starts again. */
function isTransientFetchError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /returned error: 5\d\d|Could not resolve host|Failed to connect|Connection (?:timed out|reset|refused)|Operation timed out|early EOF|unexpected disconnect|remote end hung up/i.test(
      error.message,
    )
  )
}

/**
 * A fetch from a Git host that stopped at a time limit. After it, each fetch
 * of the same remote in this process fails with this error at once for a
 * short time (CTX-1601).
 */
class GitFetchTimeLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitFetchTimeLimitError"
  }
}

/** The time of the last stop at a time limit of each remote, by URL. */
const remoteStops = new Map<string, number>()

/** After a stop at a time limit, the fetches of a remote fail at once for this long. */
const REMOTE_PAUSE_MS = 5 * 60_000

/**
 * The clones of remotes that this process keeps, the least recently used
 * first. Each value is the last operation on the clone: the next operation
 * waits for it, so one operation at a time uses a clone.
 */
const clones = new Map<string, Promise<void>>()

/** The removals of clones that went out of `clones`, until they end. */
const removals = new Map<string, Promise<void>>()

/** The private folder of this process for its clones. */
let cloneRoot: Promise<string> | undefined

/**
 * Shallow-fetch immutable commits into `directory`.
 *
 * The commits come through a bare clone of the remote that this process
 * keeps (CTX-1601). The clone keeps a ref to each recent commit that it got,
 * so Git sends only the objects that the clone does not have: a later commit
 * of a large repository costs its changes, not its full tree. Each fetch
 * still goes to the Git host with the credential of the caller, so a caller
 * without access gets no object of an earlier fetch.
 *
 * A network error or a 5xx answer starts the fetch again, at most 3 attempts
 * in total: a step with one attempt must not fail because of a short Git
 * host outage. A fetch that gets no data for 60 s, or that does not finish
 * in 10 min, stops and does not start again. Then each fetch of that remote
 * fails at once for 5 min.
 */
export async function fetchGitCommits(
  directory: string,
  input: {
    url: string
    shas: readonly string[]
    token?: string
    depth?: number
  },
): Promise<void> {
  // The clones hold objects of private repositories, and Git locks in a
  // clone that two processes share make a fetch fail: each process has its
  // own private folder, which it removes when it exits.
  cloneRoot ??= mkdtemp(join(tmpdir(), "ctxpipe-git-remotes-")).then((root) => {
    process.once("exit", () => rmSync(root, { recursive: true, force: true }))
    return root
  })
  const shas = [...new Set(input.shas)]
  const sha256 = shas[0]?.length === 64
  const clone = join(
    await cloneRoot,
    `${createHash("sha256").update(input.url).digest("hex").slice(0, 32)}${sha256 ? "-sha256" : ""}`,
  )
  const run = (
    clones.get(clone) ??
    removals.get(clone) ??
    Promise.resolve()
  ).then(() => fetchThroughClone(clone, directory, { ...input, shas, sha256 }))
  clones.delete(clone)
  clones.set(
    clone,
    run.catch(() => {}),
  )
  // A process keeps at most 32 clones. The least recently used one goes
  // when its last operation ends.
  const [oldest] = clones.size > 32 ? clones : []
  if (oldest) {
    const [path, last] = oldest
    clones.delete(path)
    const removal = last
      .then(() => rm(path, { recursive: true, force: true }))
      .catch(() => {})
    removals.set(path, removal)
    void removal.then(() => {
      if (removals.get(path) === removal) removals.delete(path)
    })
  }
  return run
}

async function fetchThroughClone(
  clone: string,
  directory: string,
  input: {
    url: string
    shas: string[]
    sha256: boolean
    token?: string
    depth?: number
  },
): Promise<void> {
  failWhenPaused(input.url)
  const depth = String(input.depth ?? 1)
  const cloneExists = await stat(join(clone, "HEAD")).then(
    () => true,
    () => false,
  )
  if (!cloneExists) {
    await mkdir(clone, { recursive: true })
    await nativeGit(clone, [
      "init",
      "--bare",
      "-q",
      "--template=",
      `--object-format=${input.sha256 ? "sha256" : "sha1"}`,
    ])
    // The fetch into `directory` asks the clone for commits by SHA.
    await nativeGit(clone, ["config", "uploadpack.allowAnySHA1InWant", "true"])
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await measuredGitFetch("git.fetch-commits", (traced) =>
        nativeGit(
          clone,
          [
            "fetch",
            "--depth",
            depth,
            "--",
            input.url,
            ...input.shas.map((sha) => `${sha}:refs/ctxpipe/fetched/${sha}`),
          ],
          undefined,
          {
            ...gitRemoteEnvironment({ url: input.url, token: input.token }),
            ...traced,
          },
          traced.GIT_TRACE_PACKFILE,
        ),
      )
      break
    } catch (error) {
      if (error instanceof GitFetchTimeLimitError) {
        const stoppedAt = Date.now()
        remoteStops.set(input.url, stoppedAt)
        log.warn({
          step: "git.fetch_time_limit",
          message: error.message,
          "git.remote.paused_until": new Date(
            stoppedAt + REMOTE_PAUSE_MS,
          ).toISOString(),
        })
        throw error
      }
      if (attempt >= 3 || !isTransientFetchError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  await nativeGit(directory, [
    "fetch",
    "--depth",
    depth,
    "--",
    clone,
    ...input.shas,
  ])
  // The commits are in `directory`, so a failure from here does not fail
  // the fetch. Only the newest commits are the base of a later fetch. Git
  // removes the objects that no kept ref reaches when the clone has many
  // packs or loose objects, so the clone does not grow without a limit.
  try {
    const refs = (
      await nativeGit(clone, [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname)",
        "refs/ctxpipe/fetched/",
      ])
    )
      .toString()
      .split("\n")
      .filter(Boolean)
    if (refs.length > 32)
      await nativeGit(
        clone,
        ["update-ref", "--stdin"],
        refs
          .slice(32)
          .map((ref) => `delete ${ref}\n`)
          .join(""),
      )
    // `nativeGit` turns automatic gc off for each command; this command
    // turns it on again at the default threshold of Git.
    await nativeGit(clone, [
      "-c",
      "gc.auto=6700",
      "-c",
      "gc.autoPackLimit=20",
      "-c",
      "gc.autoDetach=false",
      "-c",
      "gc.pruneExpire=now",
      "gc",
      "--auto",
      "--quiet",
    ])
  } catch (error) {
    log.warn({
      step: "git.clone_cleanup",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Fail at once while `url` is paused after a fetch that stopped at a time limit. */
function failWhenPaused(url: string) {
  const stoppedAt = remoteStops.get(url)
  if (stoppedAt === undefined) return
  const until = stoppedAt + REMOTE_PAUSE_MS
  if (Date.now() >= until) {
    remoteStops.delete(url)
    return
  }
  const pausedUntil = new Date(until).toISOString()
  const message = `The last fetch of this repository from its Git host stopped at a time limit at ${new Date(stoppedAt).toISOString()}. ctxpipe tries this repository again after ${pausedUntil}.`
  trace.getActiveSpan()?.setAttribute("git.remote.paused_until", pausedUntil)
  log.warn({
    step: "git.fetch_paused",
    message,
    "git.remote.paused_until": pausedUntil,
  })
  throw new GitFetchTimeLimitError(message)
}

/**
 * The tree and the parents of a commit in `directory`. The raw commit keeps
 * its parents; a shallow fetch hides them from `git log`.
 */
export async function readCommitHeader(
  directory: string,
  sha: string,
): Promise<{ tree: string; parents: string[] }> {
  const fields =
    (await nativeGit(directory, ["cat-file", "commit", sha]))
      .toString()
      .split("\n\n", 1)[0]
      ?.split("\n")
      .map((line) => line.split(" ")) ?? []
  const values = (name: string) =>
    fields.flatMap(([key, value]) => (key === name && value ? [value] : []))
  const [tree] = values("tree")
  if (!tree) throw new Error("The commit has no tree")
  return { tree, parents: values("parent") }
}

/** The tree of the pack's root folder, or null when that folder does not exist. */
export async function packRootTree(
  directory: string,
  pack: Pick<GitPack, "sha" | "root">,
): Promise<string | null> {
  if (!pack.root) return pack.sha
  try {
    const tree = (
      await nativeGit(directory, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${pack.sha}:${pack.root}`,
      ])
    )
      .toString()
      .trim()
    const type = (await nativeGit(directory, ["cat-file", "-t", tree]))
      .toString()
      .trim()
    return type === "tree" ? tree : null
  } catch {
    return null
  }
}

export async function nativeGit(
  directory: string,
  args: string[],
  input?: Uint8Array | string | { file: string },
  env?: NodeJS.ProcessEnv,
  /**
   * For a fetch: the file that receives the pack as it comes
   * (`GIT_TRACE_PACKFILE`). The fetch then has no fixed time limit: it stops
   * when the file does not grow for 60 s, or after 10 min.
   */
  progressFile?: string,
): Promise<Buffer> {
  const call = withGitProcessSlot(() =>
    startNativeGit(directory, args, input, env, progressFile),
  )
  const settled = call.then(
    () => undefined,
    () => undefined,
  )
  const calls = pending.get(directory) ?? new Set()
  calls.add(settled)
  pending.set(directory, calls)
  void settled.then(() => {
    calls.delete(settled)
    if (!calls.size && pending.get(directory) === calls)
      pending.delete(directory)
  })
  return call
}

async function startNativeGit(
  directory: string,
  args: string[],
  input?: Uint8Array | string | { file: string },
  env?: NodeJS.ProcessEnv,
  progressFile?: string,
): Promise<Buffer> {
  if (closing.has(directory))
    throw new Error("The temporary Git directory is closed")
  const started = Date.now()
  try {
    return await runNativeGit(directory, args, input, env, progressFile)
  } catch (error) {
    throw describeGitFailure(error, args, Date.now() - started)
  }
}

/** Git output that a failure message keeps, at most. */
const STDERR_LIMIT = 4000
const GIT_TIME_LIMIT_MS = 60_000

/**
 * Add the exit code or the signal and the end of the Git error output to a
 * failed Git command, and record them in the active span and the log. The
 * error object stays the same, so its `code` and `syscall` stay for the
 * spawn retry (CTX-952). A spawn error has no exit status and stays as it is.
 */
function describeGitFailure(
  error: unknown,
  args: readonly string[],
  elapsedMs: number,
): unknown {
  if (!(error instanceof Error)) return error
  const failure = error as Error & {
    code?: unknown
    signal?: NodeJS.Signals | null
    stdout?: Buffer | string
    stderr?: Buffer | string
  }
  // Only a Git process that ran has an exit status; startGitProcess sets `cmd`.
  if (!("cmd" in failure) || typeof failure.code === "string") return error
  const exitCode = typeof failure.code === "number" ? failure.code : undefined
  const signal = failure.signal ?? undefined
  const stderr = String(failure.stderr ?? "").trim()
  const shownStderr =
    stderr.length > STDERR_LIMIT
      ? `…${stderr.slice(stderr.length - STDERR_LIMIT)}`
      : stderr
  const timedOut = Boolean(signal) && elapsedMs >= GIT_TIME_LIMIT_MS
  const status = signal
    ? `stopped by ${signal}${timedOut ? ` at the ${GIT_TIME_LIMIT_MS / 1000} s time limit` : ""}`
    : `exit code ${exitCode ?? "unknown"}`
  // The subcommand is the first argument that is not an option or the value
  // of a `-c` option.
  const command =
    args.find((arg, at) => !arg.startsWith("-") && args[at - 1] !== "-c") ??
    "git"
  // `merge-base` and `merge-tree` answer "no" (not an ancestor, a
  // conflict) with exit code 1. That is not a failure: the caller reads
  // the code (CTX-1089).
  if (exitCode === 1 && (command === "merge-base" || command === "merge-tree"))
    return error
  // `push --porcelain` writes each ref and why it was rejected to stdout
  // (`!\t<from>:<to>\t[rejected] (fetch first)`), not to the error output.
  const rejections =
    command === "push"
      ? String(failure.stdout ?? "")
          .split("\n")
          .filter((line) => line.startsWith("!"))
          .join("\n")
          .slice(0, STDERR_LIMIT)
      : ""
  const firstLine = failure.message.split("\n", 1)[0]
  failure.message = `${firstLine}\ngit ${command} ${status} after ${Math.round(elapsedMs / 1000)} s${shownStderr ? `: ${shownStderr}` : " with no error output"}${rejections ? `\n${rejections}` : ""}`
  const details = {
    "git.command": command,
    "git.exit_code": exitCode,
    "git.signal": signal,
    "git.timed_out": timedOut,
    "git.duration_ms": elapsedMs,
    "git.stderr": shownStderr,
    ...(rejections ? { "git.push_rejections": rejections } : {}),
  }
  trace.getActiveSpan()?.setAttributes(details)
  log.warn({
    step: "git.command_failed",
    message: failure.message,
    ...details,
  })
  return error
}

async function runNativeGit(
  directory: string,
  args: string[],
  input?: Uint8Array | string | { file: string },
  env?: NodeJS.ProcessEnv,
  progressFile?: string,
): Promise<Buffer> {
  const result = startGitProcess(
    [
      "-c",
      "core.hooksPath=/dev/null",
      // No detached `gc --auto` or maintenance task may outlive the command.
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-C",
      directory,
      ...args,
    ],
    {
      env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: progressFile ? 0 : GIT_TIME_LIMIT_MS,
    },
  )
  const entry = {
    kill: result.stop,
    done: result.done.then(
      () => undefined,
      () => undefined,
    ),
  }
  const processes = running.get(directory) ?? new Set()
  processes.add(entry)
  running.set(directory, processes)
  void entry.done.then(() => {
    processes.delete(entry)
    if (!processes.size && running.get(directory) === processes)
      running.delete(directory)
  })
  if (typeof input === "object" && "file" in input) {
    const stdin = result.stdin
    if (!stdin) throw new Error("Native Git did not expose standard input")
    const streamed = pipeline(createReadStream(input.file), stdin).catch(
      (error: NodeJS.ErrnoException) => {
        // Git can exit before it reads all of its input. Then its exit
        // status and its stderr give the result, not the broken pipe
        // (EPIPE on macOS, a premature close on Linux).
        if (
          error.code === "EPIPE" ||
          error.code === "ERR_STREAM_PREMATURE_CLOSE"
        )
          return
        result.stop()
        throw error
      },
    )
    try {
      return (await Promise.all([result.done, streamed]))[0]
    } finally {
      // A failed input stream kills Git; its slot stays taken until it exits.
      await entry.done
    }
  }
  // Git can exit before it reads all of its input, and a process that did not
  // start has no reader; the exit status gives the result, not the pipe.
  result.stdin?.on("error", () => {})
  if (input !== undefined) result.stdin?.end(input)
  if (!progressFile) return await result.done
  // The time limit of a fetch follows its progress, not the clock alone
  // (CTX-1601): a throttled Git host can need minutes for a large pack, but
  // a fetch that gets no data for this long stops.
  const stallMs = 60_000
  const startedAt = Date.now()
  let progressAt = startedAt
  let received = 0
  let stopped: string | undefined
  const watch = setInterval(() => {
    void stat(progressFile).then(
      ({ size }) => check(size),
      () => check(0),
    )
  }, 1_000)
  const check = (size: number) => {
    if (stopped) return
    const now = Date.now()
    if (size > received) {
      received = size
      progressAt = now
    }
    const got = `${(received / 2 ** 20).toFixed(1)} MiB received`
    if (now - progressAt >= stallMs)
      stopped = `The Git host sent no data for ${stallMs / 1000} s, so ctxpipe stopped the fetch (${got}).`
    else if (now - startedAt >= 10 * 60_000)
      stopped = `The fetch from the Git host did not finish in 10 min, so ctxpipe stopped it (${got}).`
    if (stopped) result.stop()
  }
  try {
    return await result.done
  } catch (error) {
    throw stopped ? new GitFetchTimeLimitError(stopped) : error
  } finally {
    clearInterval(watch)
  }
}

/**
 * Pack the objects of `revs` (`git pack-objects --revs` input lines) as
 * base64. Git writes the pack to a file, not to standard output: the size of
 * the pack grows with the size of the repository, and a buffered standard
 * output has a fixed limit (CTX-933).
 */
export async function packGitObjects(
  directory: string,
  revs: readonly string[],
  /**
   * The commits that each step fetches again from the Git host (CTX-955):
   * the pack holds only the objects that they do not have. `null` packs all
   * objects (a pack with no base, or an unborn tree).
   */
  base: GitPackBase | null,
): Promise<string> {
  // A tree in `revs` is not a commit: only an excluded tree excludes the
  // objects below it.
  const excluded = (base?.shas ?? []).flatMap((sha) => [
    `^${sha}`,
    `^${sha}^{tree}`,
  ])
  const scratch = await mkdtemp(join(tmpdir(), "ctxpipe-pack-"))
  try {
    const name = (
      await nativeGit(
        directory,
        ["pack-objects", "--revs", "-q", join(scratch, "pack")],
        `${[...revs, ...excluded].join("\n")}\n`,
      )
    )
      .toString()
      .trim()
    if (!/^[0-9a-f]{40,64}$/.test(name))
      throw new Error("Git did not name the pack that it wrote")
    const file = join(scratch, `pack-${name}.pack`)
    // A pack travels as one base64 string. A Workspace write workflow keeps
    // that string in the output of a durable step, a Postgres jsonb value of
    // at most about 256 MiB. 190 MiB of pack is about 253 MiB of base64.
    const maxBytes = 190 * 2 ** 20
    const { size } = await stat(file)
    if (size > maxBytes)
      throw new Error(
        `The Git repository is too large for ctxpipe to read in one step: the Git pack of its commit is ${Math.ceil(size / 2 ** 20)} MiB, and the limit is ${maxBytes / 2 ** 20} MiB.`,
      )
    return (await readFile(file)).toString("base64")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function captureGitPack(
  directory: string,
  sha: string,
  /** See `packGitObjects`. */
  base: GitPackBase | null,
  additionalShas: readonly string[] = [],
): Promise<GitPack> {
  const objects = await packGitObjects(
    directory,
    [sha, ...additionalShas],
    base,
  )
  if (base) return { sha, objects, shallow: "", base }
  const shallow = await readFile(join(directory, ".git/shallow"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    },
  )
  return { sha, objects, shallow }
}

/**
 * Decode a base64 pack to a file in the object store of `directory` and
 * index it there. Git reads the file itself: the pack does not go through a
 * pipe that the event loop of this process must feed, and the decode holds
 * only one chunk of the pack in memory at a time (CTX-954).
 */
async function indexGitPack(directory: string, objects: string) {
  const packs = join(directory, ".git/objects/pack")
  const incoming = join(packs, "pack-incoming.pack")
  const file = await open(incoming, "w")
  try {
    // A multiple of 4 base64 characters decodes without a partial byte. One
    // buffer takes each decoded chunk in turn.
    const chunk = 4 * 2 ** 20
    const bytes = Buffer.allocUnsafe((chunk / 4) * 3)
    for (let at = 0; at < objects.length; at += chunk) {
      const length = bytes.write(objects.slice(at, at + chunk), "base64")
      await file.write(bytes, 0, length)
    }
  } finally {
    await file.close()
  }
  // Git writes the index (and its reverse index) next to the pack. It reads
  // a pack through any index in this folder, so no rename is needed.
  await nativeGit(directory, ["index-pack", incoming])
}

export async function withGitDirectory<T>(
  sha: string,
  operation: (directory: string) => Promise<T>,
  pack: GitPack | undefined,
  /** Required when the pack has a base. */
  read: GitRemoteRead | null,
): Promise<T> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))
    throw new Error("An immutable full Git SHA is required")
  const directory = await mkdtemp(join(tmpdir(), "ctxpipe-write-step-"))
  try {
    await nativeGit(directory, [
      "init",
      "--template=",
      `--object-format=${sha.length === 64 ? "sha256" : "sha1"}`,
    ])
    if (pack) {
      if (pack.sha !== sha) throw new Error("Git pack identity mismatch")
      if (pack.base) {
        if (read === null)
          throw new Error(
            "A Git pack with a base needs the read access of its Workspace",
          )
        assertBaseOfBoundRepository(pack.base, read)
        await fetchGitCommits(directory, {
          url: pack.base.url,
          shas: pack.base.shas,
          token: await read.token(),
          depth: pack.base.depth,
        })
      }
      if (pack.objects) await indexGitPack(directory, pack.objects)
      if (pack.shallow)
        await writeFile(join(directory, ".git/shallow"), pack.shallow)
      await nativeGit(directory, ["checkout", "--detach", sha])
    }
    return await operation(directory)
  } finally {
    // No Git process starts in the directory from here. A process that the
    // operation left running (a rejected sibling of a parallel read) must
    // exit before the removal; it could write meanwhile.
    closing.add(directory)
    try {
      const left = [...(running.get(directory) ?? [])]
      for (const child of left) child.kill()
      // A queued call gets a slot and rejects at once because of `closing`.
      await Promise.all([...(pending.get(directory) ?? [])])
      // Second layer only: the cause is handled above.
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      })
    } catch (error) {
      // A failed removal must not hide the error of the operation.
      log.warn({
        step: "git.temporary_directory_cleanup",
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      closing.delete(directory)
    }
  }
}

/**
 * Read selected immutable blobs; the workflow owns the surrounding durable
 * step. With `limit`, a blob that `limit.applies` to and that is larger than
 * `limit.maxBytes`, or that is not text (it has a NUL byte), comes back with
 * empty content and the reason in `omitted`. Only regular files count: a
 * symlink or a submodule is the same as a missing file. The size check comes before the
 * read, so a large blob is never in memory.
 */
export async function readGitFiles(
  pack: GitPack,
  include: (path: string) => boolean,
  limit: { maxBytes: number; applies: (path: string) => boolean } | undefined,
  read: GitRemoteRead | null,
): Promise<
  Array<{ path: string; content: string; omitted?: "too_large" | "binary" }>
> {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const tree = await packRootTree(directory, pack)
      if (!tree) return []
      const entries = (
        await nativeGit(directory, ["ls-tree", "-r", "-l", "-z", tree])
      )
        .toString()
        .split("\0")
        .flatMap((line) => {
          const tab = line.indexOf("\t")
          const path = line.slice(tab + 1)
          if (tab < 0 || !path || !include(path)) return []
          const [mode = "", kind = "", , size] = line.slice(0, tab).split(/\s+/)
          return isRegularFile({ mode, kind })
            ? [{ path, size: Number(size) }]
            : []
        })
      const files: Array<{
        path: string
        content: string
        omitted?: "too_large" | "binary"
      }> = []
      for (const { path, size } of entries) {
        const limited = limit?.applies(path) ?? false
        if (limited && size > (limit?.maxBytes ?? 0)) {
          files.push({ path, content: "", omitted: "too_large" })
          continue
        }
        const bytes = await nativeGit(directory, ["show", `${tree}:${path}`])
        files.push(
          limited && bytes.includes(0)
            ? { path, content: "", omitted: "binary" }
            : { path, content: bytes.toString() },
        )
      }
      return files
    },
    pack,
    read,
  )
}

/** Capture immutable remote trees with a transient caller-owned read credential. */
export async function readGitPackFromRemote(input: {
  url: string
  sha: string
  additionalShas?: readonly string[]
  token?: string
  /** Workspace root folder; `""` or absent is the repository root. */
  root?: string
}): Promise<GitPack> {
  return withGitDirectory(
    input.sha,
    async (directory) => {
      await fetchGitCommits(directory, {
        url: input.url,
        shas: [input.sha, ...(input.additionalShas ?? [])],
        token: input.token,
      })
      const pack = await captureGitPack(
        directory,
        input.sha,
        null,
        input.additionalShas,
      )
      return input.root ? { ...pack, root: input.root } : pack
    },
    undefined,
    null,
  )
}

/**
 * The size in bytes of each blob of `blobs`, in order, with no blob read
 * (`git cat-file --batch-check`). A caller checks the sizes before it reads
 * the blobs, because the output of one git call has a limit.
 */
export async function readGitBlobSizes(
  directory: string,
  blobs: readonly string[],
): Promise<number[]> {
  if (blobs.length === 0) return []
  const output = await nativeGit(
    directory,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    `${blobs.join("\n")}\n`,
  )
  const lines = output.toString().split("\n")
  return blobs.map((blob, index) => {
    const [name, type, size] = (lines[index] ?? "").split(" ")
    if (name !== blob || type !== "blob" || !Number.isInteger(Number(size)))
      throw new Error(`Git has no blob ${blob}`)
    return Number(size)
  })
}

/** The bytes of each blob, in the order of `blobs` (`git cat-file --batch`). */
export async function readGitBlobs(
  directory: string,
  blobs: readonly string[],
): Promise<Buffer[]> {
  if (blobs.length === 0) return []
  const output = await nativeGit(
    directory,
    ["cat-file", "--batch"],
    `${blobs.join("\n")}\n`,
  )
  const out: Buffer[] = []
  let at = 0
  for (const blob of blobs) {
    const end = output.indexOf(10, at)
    const header = output.subarray(at, end).toString()
    const size = Number(header.split(" ")[2])
    if (!header.startsWith(`${blob} blob `) || !Number.isInteger(size))
      throw new Error(`Git has no blob ${blob}`)
    out.push(output.subarray(end + 1, end + 1 + size))
    at = end + 1 + size + 1
  }
  return out
}

/** Every blob below the pack's root folder, with root-relative paths. */
export async function listPackBlobs(
  directory: string,
  pack: Pick<GitPack, "sha" | "root">,
): Promise<Array<{ path: string; sha: string }>> {
  const tree = await packRootTree(directory, pack)
  return tree ? listTreeBlobs(directory, tree) : []
}

/** Every blob in a tree with its object id (git ls-tree), paths unquoted. */
export async function listTreeBlobs(
  directory: string,
  treeish: string,
  /** Only the blobs under these paths, when set. */
  paths?: readonly string[],
): Promise<Array<{ path: string; sha: string }>> {
  const pathspec = paths ? ["--", ...paths] : []
  return (
    await nativeGit(directory, ["ls-tree", "-r", "-z", treeish, ...pathspec])
  )
    .toString()
    .split("\0")
    .flatMap((entry) => {
      const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry)
      return match?.[1] && match[2] ? [{ path: match[2], sha: match[1] }] : []
    })
}
