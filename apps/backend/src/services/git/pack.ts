import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import { trace } from "@opentelemetry/api"
import { log } from "../../observability/logger.js"
import { gitRemoteEnvironment } from "./clone-tree.js"
import { withGitProcessSlot } from "./process-slot.js"

const execute = promisify(execFile)

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

/**
 * Immutable commits on a remote. The org and connection select a read
 * credential in the step that fetches; no credential is durable.
 */
export type GitPackBase = {
  url: string
  orgId: string
  connectionId: string | null
  shas: string[]
}

/** The base of each temporary directory that `withGitDirectory` fetched. */
const bases = new Map<string, GitPackBase>()

/** A pack of remote commits with no objects in it: each step fetches them. */
export function remoteGitPack(input: {
  base: Omit<GitPackBase, "shas">
  sha: string
  additionalShas?: readonly string[]
  root?: string
}): GitPack {
  return {
    sha: input.sha,
    objects: "",
    shallow: "",
    ...(input.root ? { root: input.root } : {}),
    base: {
      ...input.base,
      shas: [input.sha, ...(input.additionalShas ?? [])],
    },
  }
}

async function fetchGitPackBase(directory: string, base: GitPackBase) {
  // Late import: the credential lookup is in the domain layer.
  const [{ resolveRepositoryReadCredential }, { parseEnv }] = await Promise.all(
    [
      import("../../domain/workspaces/resolve-revision.js"),
      import("../../config/env.js"),
    ],
  )
  const token = await resolveRepositoryReadCredential({
    orgId: base.orgId,
    env: parseEnv(process.env),
    remote: { url: base.url, connectionId: base.connectionId },
  })
  await nativeGit(
    directory,
    ["fetch", "--depth", "1", "--", base.url, ...base.shas],
    undefined,
    gitRemoteEnvironment({ url: base.url, token }),
  )
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
): Promise<Buffer> {
  const call = withGitProcessSlot(() =>
    startNativeGit(directory, args, input, env),
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
): Promise<Buffer> {
  if (closing.has(directory))
    throw new Error("The temporary Git directory is closed")
  const started = Date.now()
  try {
    return await runNativeGit(directory, args, input, env)
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
    stderr?: Buffer | string
  }
  // Only a Git process that ran has an exit status; execFile sets `cmd`.
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
  const firstLine = failure.message.split("\n", 1)[0]
  failure.message = `${firstLine}\ngit ${command} ${status} after ${Math.round(elapsedMs / 1000)} s${shownStderr ? `: ${shownStderr}` : " with no error output"}`
  const details = {
    "git.command": command,
    "git.exit_code": exitCode,
    "git.signal": signal,
    "git.timed_out": timedOut,
    "git.duration_ms": elapsedMs,
    "git.stderr": shownStderr,
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
): Promise<Buffer> {
  const result = execute(
    "git",
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
      encoding: "buffer",
      timeout: GIT_TIME_LIMIT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  )
  const entry = {
    kill: () => result.child.kill(),
    done: result.then(
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
    const stdin = result.child.stdin
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
        result.child.kill()
        throw error
      },
    )
    try {
      return (await Promise.all([result, streamed]))[0].stdout
    } finally {
      // A failed input stream kills Git; its slot stays taken until it exits.
      await entry.done
    }
  }
  // Git can exit before it reads all of its input, and a process that did not
  // start has no reader; the exit status gives the result, not the pipe.
  result.child.stdin?.on("error", () => {})
  if (input !== undefined) result.child.stdin?.end(input)
  return (await result).stdout
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
): Promise<string> {
  // The base commits come from the Git host again in each step: the pack
  // holds only the objects that they do not have (CTX-955).
  // A tree in `revs` is not a commit: only an excluded tree excludes the
  // objects below it.
  const excluded = (bases.get(directory)?.shas ?? []).flatMap((sha) => [
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
  additionalShas: readonly string[] = [],
): Promise<GitPack> {
  const objects = await packGitObjects(directory, [sha, ...additionalShas])
  const base = bases.get(directory)
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
  pack?: GitPack,
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
        await fetchGitPackBase(directory, pack.base)
        bases.set(directory, pack.base)
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
      bases.delete(directory)
    }
  }
}

/**
 * Read selected immutable blobs; the workflow owns the surrounding durable
 * step. With `limit`, a blob that `limit.applies` to and that is larger than
 * `limit.maxBytes`, or that is not text (it has a NUL byte), comes back with
 * empty content and the reason in `omitted`. The size check comes before the
 * read, so a large blob is never in memory.
 */
export async function readGitFiles(
  pack: GitPack,
  include: (path: string) => boolean,
  limit?: { maxBytes: number; applies: (path: string) => boolean },
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
          const [, type, , size] = line.slice(0, tab).split(/\s+/)
          return type === "blob" ? [{ path, size: Number(size) }] : []
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
  return withGitDirectory(input.sha, async (directory) => {
    await nativeGit(
      directory,
      [
        "fetch",
        "--depth",
        "1",
        "--",
        input.url,
        input.sha,
        ...(input.additionalShas ?? []),
      ],
      undefined,
      gitRemoteEnvironment({ url: input.url, token: input.token }),
    )
    const pack = await captureGitPack(
      directory,
      input.sha,
      input.additionalShas,
    )
    return input.root ? { ...pack, root: input.root } : pack
  })
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
