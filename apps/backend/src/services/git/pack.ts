import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import { gitRemoteEnvironment } from "./clone-tree.js"

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
 * Native pack and shallow boundary; no filesystem locator or credential is
 * durable. `root` is the Workspace root folder (CTX-709): the read and write
 * helpers use paths relative to it and never touch a path outside it.
 */
export type GitPack = {
  sha: string
  objects: string
  shallow: string
  root?: string
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
      timeout: 60_000,
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
    return (await Promise.all([result, streamed]))[0].stdout
  }
  if (input !== undefined) result.child.stdin?.end(input)
  return (await result).stdout
}

/**
 * Pack the objects of `revs` (`git pack-objects --revs` input lines). Git
 * writes the pack to a file, not to standard output: the size of the pack
 * grows with the size of the repository, and a buffered standard output has
 * a fixed limit (CTX-933).
 */
export async function packGitObjects(
  directory: string,
  revs: readonly string[],
): Promise<Buffer> {
  const scratch = await mkdtemp(join(tmpdir(), "ctxpipe-pack-"))
  try {
    const name = (
      await nativeGit(
        directory,
        ["pack-objects", "--revs", "-q", join(scratch, "pack")],
        `${revs.join("\n")}\n`,
      )
    )
      .toString()
      .trim()
    if (!/^[0-9a-f]{40,64}$/.test(name))
      throw new Error("Git did not name the pack that it wrote")
    const file = join(scratch, `pack-${name}.pack`)
    // A pack travels as one base64 string. V8 refuses a string of more than
    // about 512 Mi characters; 256 MiB of pack is about 342 Mi characters.
    const maxBytes = 256 * 2 ** 20
    const { size } = await stat(file)
    if (size > maxBytes)
      throw new Error(
        `The Git repository is too large for ctx| to read in one step: the Git pack of its commit is ${Math.ceil(size / 2 ** 20)} MiB, and the limit is ${maxBytes / 2 ** 20} MiB.`,
      )
    return await readFile(file)
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
  const shallow = await readFile(join(directory, ".git/shallow"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    },
  )
  return { sha, objects: objects.toString("base64"), shallow }
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
      await nativeGit(
        directory,
        ["index-pack", "--stdin"],
        Buffer.from(pack.objects, "base64"),
      )
      if (pack.shallow)
        await writeFile(join(directory, ".git/shallow"), pack.shallow)
      await nativeGit(directory, ["checkout", "--detach", sha])
    }
    return await operation(directory)
  } finally {
    // A Git process that the operation left running (a rejected sibling of a
    // parallel read) must exit before the removal; it could write meanwhile.
    const left = [...(running.get(directory) ?? [])]
    for (const child of left) child.kill()
    await Promise.all(left.map((child) => child.done))
    // Second layer only: the cause is handled above.
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    })
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
