import { execFile, spawn } from "node:child_process"
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { trace } from "@opentelemetry/api"

import { withGitProcessSlot } from "./process-slot.js"
import {
  workspaceRelativePath,
  workspaceRepositoryPath,
} from "./root-folder.js"

const execFileAsync = promisify(execFile)

async function gitExec(
  args: string[],
  options: Parameters<typeof execFileAsync>[2] = {},
  input?: string,
) {
  try {
    return await withGitProcessSlot(() => {
      const execution = execFileAsync("git", args, {
        ...options,
        encoding: "buffer",
      })
      // A process that did not start has no reader for its input.
      execution.child.stdin?.on("error", () => {})
      if (input !== undefined) execution.child.stdin?.end(input)
      return execution
    })
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      message?: string
      killed?: boolean
    }
    if (
      err.code === "ENOENT" ||
      /not found in \$PATH/i.test(err.message ?? "")
    ) {
      throw new Error(
        "git is not installed on this service; cannot read a repository by clone.",
      )
    }
    const timeout = options?.timeout
    if (
      timeout &&
      err.killed &&
      err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      throw gitTimeoutError(args, timeout)
    throw error
  }
}

/** A known sentence for the failure card; the arguments hold no credential. */
function gitTimeoutError(args: readonly string[], timeout: number) {
  const command = args.find(
    (arg, index) => !arg.startsWith("-") && args[index - 1] !== "-C",
  )
  return new Error(
    `Git ${command} did not finish in the time that ctxpipe waits (${Math.round(timeout / 1000)} s).`,
  )
}

/**
 * Run Git with its standard output in a temporary file, then read the file.
 * The output of these commands grows with the repository, and a buffered
 * standard output has a fixed limit (CTX-933). A file above `maxBytes` is not
 * read, so a very large history cannot exhaust the memory of the worker.
 */
export async function gitOutput(
  args: string[],
  timeout: number,
  input?: string,
  maxBytes = 512 * 2 ** 20,
): Promise<Buffer> {
  const scratch = await mkdtemp(join(tmpdir(), "ctxpipe-git-output-"))
  try {
    const file = join(scratch, "stdout")
    const stdout = await open(file, "w")
    try {
      await withGitProcessSlot(
        () =>
          new Promise<void>((resolve, reject) => {
            const child = spawn("git", args, {
              stdio: [
                input === undefined ? "ignore" : "pipe",
                stdout.fd,
                "pipe",
              ],
            })
            let stderr = ""
            let timedOut = false
            const timer = setTimeout(() => {
              timedOut = true
              child.kill()
            }, timeout)
            child.stderr?.on("data", (chunk: Buffer) => {
              stderr = (stderr + chunk.toString()).slice(-4096)
            })
            // Git can exit before it reads all of its input; its exit status
            // gives the result, not the broken pipe.
            child.stdin?.on("error", () => {})
            child.stdin?.end(input)
            child.on("error", (error: NodeJS.ErrnoException) => {
              clearTimeout(timer)
              reject(
                error.code === "ENOENT"
                  ? new Error(
                      "git is not installed on this service; cannot read a repository by clone.",
                    )
                  : error,
              )
            })
            child.on("close", (code) => {
              clearTimeout(timer)
              if (timedOut) reject(gitTimeoutError(args, timeout))
              else if (code === 0) resolve()
              else
                reject(
                  Object.assign(
                    new Error(
                      `Command failed: git ${args.join(" ")}\n${stderr}`,
                    ),
                    { code, stderr },
                  ),
                )
            })
          }),
      )
    } finally {
      await stdout.close()
    }
    const { size } = await stat(file)
    if (size > maxBytes)
      throw new Error(
        `The Git repository is too large for ctxpipe to read in one step: the Git output is ${Math.ceil(size / 2 ** 20)} MiB, and the limit is ${Math.floor(maxBytes / 2 ** 20)} MiB.`,
      )
    return await readFile(file)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

type GitShaFile = { kind: "missing" } | { kind: "bytes"; bytes: Uint8Array }

export const GIT_REMOTE_ACCESS_MESSAGES = {
  noCredential:
    "ctxpipe has no access to this repository. Connect GitHub to this Workspace, then retry.",
  denied:
    "ctxpipe has no access to this repository. Add the repository to the GitHub App installation, or reconnect GitHub, then refresh.",
} as const

/** The remote refused the read credential, or the read needs one and has none. */
export class GitRemoteAccessError extends Error {
  /** 401 or 403 when Git reported it; a write uses it to pause. */
  readonly status: 401 | 403 | undefined
  constructor(input: { hasCredential: boolean; stderr: string }) {
    super(
      input.hasCredential
        ? GIT_REMOTE_ACCESS_MESSAGES.denied
        : GIT_REMOTE_ACCESS_MESSAGES.noCredential,
    )
    this.name = "GitRemoteAccessError"
    this.status = /returned error: 403/.test(input.stderr)
      ? 403
      : /returned error: 401|Authentication failed/i.test(input.stderr)
        ? 401
        : undefined
  }
}

/**
 * Resolve a branch or a tag once; subsequent reads fetch the returned
 * immutable SHA. A branch wins over a tag of the same name, and an annotated
 * tag resolves to its commit.
 */
export async function resolveGitRemoteTip(input: {
  url: string
  branch?: string | null
  token?: string
  /**
   * The full git environment of a checked plain git remote (CTX-815). It
   * replaces the environment of the process.
   */
  env?: NodeJS.ProcessEnv
}): Promise<{ sha: string; branch: string } | null> {
  const requested = input.branch?.trim()
  const refs = requested
    ? [
        `refs/heads/${requested}`,
        `refs/tags/${requested}^{}`,
        `refs/tags/${requested}`,
      ]
    : ["HEAD"]
  const { stdout } = await gitExec(
    [
      "ls-remote",
      "--symref",
      "--",
      input.url,
      ...(requested ? refs : ["HEAD"]),
    ],
    {
      timeout: 60_000,
      env: input.env ?? gitRemoteEnvironment(input),
    },
  ).catch((error: unknown) => {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "")
    if (
      /could not read (?:Username|Password)|Authentication failed|Repository not found|returned error: 40[134]/i.test(
        stderr,
      )
    )
      throw new GitRemoteAccessError({
        hasCredential: Boolean(input.token),
        stderr,
      })
    throw error
  })
  const lines = stdout.toString("utf8").trim().split("\n")
  const found = new Map(
    lines
      .map((line) => line.split("\t"))
      .filter(([value]) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? ""))
      .map(([value, name]) => [name, value] as const),
  )
  const sha = refs.map((ref) => found.get(ref)).find(Boolean)
  const branch =
    requested ??
    lines
      .find(
        (line) =>
          line.startsWith("ref: refs/heads/") && line.endsWith("\tHEAD"),
      )
      ?.slice("ref: refs/heads/".length, -"\tHEAD".length)
  return sha && branch ? { sha, branch } : null
}

export function gitRemoteEnvironment(input: {
  url: string
  token?: string
}): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" }
  const remote = URL.canParse(input.url) ? new URL(input.url) : null
  if (
    remote?.password ||
    (remote && ["http:", "https:"].includes(remote.protocol) && remote.username)
  )
    throw new Error("Git reads require a credential-free remote")
  if (!input.token) return env
  if (!remote || !["https:", "http:"].includes(remote.protocol))
    throw new Error(
      "Token-authenticated Git reads require a credential-free HTTP remote",
    )
  return {
    ...env,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: `http.${remote.toString()}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "http.followRedirects",
    GIT_CONFIG_VALUE_2: "false",
  }
}

function isSafeGitPath(path: string): boolean {
  if (!path || path.includes("\0")) return false
  const parts = path.replace(/\\/g, "/").split("/")
  return parts.every((part) => part !== "" && part !== "." && part !== "..")
}

/** Time one git call in a span, so a trace shows which fetch is slow. */
function timedGit<T>(name: string, work: () => Promise<T>): Promise<T> {
  return trace
    .getTracer("ctxpipe-backend")
    .startActiveSpan(name, async (span) => {
      try {
        return await work()
      } finally {
        span.end()
      }
    })
}

/**
 * Make an empty Git directory for a read of `sha` from `url`. With
 * `treesOnly`, the directory is a partial clone that gets no blob unless a
 * fetch names it. The directory keeps no credential.
 */
async function initGitReadDirectory(
  dir: string,
  input: { url: string; sha: string; treesOnly?: boolean },
): Promise<void> {
  await gitExec(
    [
      "init",
      dir,
      `--object-format=${input.sha.length === 64 ? "sha256" : "sha1"}`,
    ],
    { timeout: 15_000 },
  )
  await gitExec(["-C", dir, "remote", "add", "origin", input.url], {
    timeout: 15_000,
  })
  if (input.treesOnly)
    for (const [key, value] of [
      ["remote.origin.promisor", "true"],
      ["remote.origin.partialclonefilter", "blob:none"],
    ] as const)
      await gitExec(["-C", dir, "config", key, value], { timeout: 15_000 })
}

/**
 * The contents of the blobs `shas`, in order, from one `cat-file --batch`.
 * The caller keeps all the contents in memory, so it selects the blobs and
 * checks their sizes first.
 */
async function readGitBlobs(
  dir: string,
  shas: readonly string[],
): Promise<Buffer[]> {
  if (shas.length === 0) return []
  const stdout = await gitOutput(
    ["-C", dir, "--no-lazy-fetch", "cat-file", "--batch"],
    60_000,
    `${shas.join("\n")}\n`,
  )
  let offset = 0
  return shas.map((expected) => {
    const newline = stdout.indexOf(10, offset)
    if (newline < 0) throw new Error("Incomplete Git batch response")
    const [sha, kind, sizeText] = stdout
      .subarray(offset, newline)
      .toString("ascii")
      .split(" ")
    const size = Number(sizeText)
    const start = newline + 1
    const end = start + size
    if (
      sha !== expected ||
      kind !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end >= stdout.length ||
      stdout[end] !== 10
    )
      throw new Error("Invalid blob in immutable Git batch")
    offset = end + 1
    return stdout.subarray(start, end)
  })
}

async function withFetchedGitSha<T>(
  input: {
    url: string
    sha: string
    token?: string
    includeIntroducingCommits?: boolean
    /** Fetch the trees only; `fetchBlobs` gets each blob that the read needs. */
    treesOnly?: boolean
  },
  read: (
    dir: string,
    fetchBlobs: (shas: readonly string[]) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.sha))
    throw new Error("A full immutable Git commit SHA is required")
  const env = gitRemoteEnvironment(input)
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-hydrate-"))
  try {
    await initGitReadDirectory(dir, input)
    // A remote without filter support sends every blob; the read still works.
    const filter = input.treesOnly ? ["--filter=blob:none"] : []
    await timedGit("git.fetch-tip", () =>
      gitExec(
        ["-C", dir, "fetch", ...filter, "--depth", "1", "origin", input.sha],
        {
          timeout: 60_000,
          env,
        },
      ),
    )
    if (input.includeIntroducingCommits) {
      // The history walk reads commits and trees only. It needs no old blob,
      // and the blobs of a large history are most of its bytes. The tip
      // blobs came with the fetch above, so the walk adds only the rest.
      await timedGit("git.fetch-history", () =>
        gitExec(
          [
            // Settings for this command only, so the budget of native Git
            // commands per tree does not grow.
            "-c",
            "remote.origin.promisor=true",
            "-c",
            "remote.origin.partialclonefilter=blob:none",
            "-C",
            dir,
            "fetch",
            "--no-tags",
            "--filter=blob:none",
            "--unshallow",
            "origin",
            input.sha,
          ],
          // The full history of a large repository takes much longer than
          // its newest commit.
          { timeout: 10 * 60_000, env },
        ),
      )
    }
    return await read(dir, async (shas) => {
      if (!input.treesOnly || shas.length === 0) return
      // One fetch for all the blobs, not one lazy fetch for each blob.
      await gitExec(
        ["-C", dir, "fetch", "--no-tags", ...filter, "origin", ...shas],
        { timeout: 60_000, env },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * The entries of the fetched tree. After a tree-only fetch (`prefix`), a blob
 * is not on disk, and `ls-tree -l` would need it for its size: the entries
 * then have no size.
 */
async function listTreeEntries(
  dir: string,
  prefix?: string,
): Promise<
  Array<{ kind: string; sha: string; path: string; size: number | null }>
> {
  const stdout = await gitOutput(
    [
      "-C",
      dir,
      // No lazy fetch: the temporary copy has no credential, so the fetches
      // with one are the only network reads.
      "--no-lazy-fetch",
      "ls-tree",
      prefix ? "-rz" : "-rlz",
      "--full-tree",
      "FETCH_HEAD",
      ...(prefix ? ["--", prefix] : []),
    ],
    60_000,
  )
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const entry = /^\d+ (\w+) ([0-9a-f]+)(?: +(\d+|-))?\t([\s\S]+)$/.exec(
        record,
      )
      if (!entry?.[1] || !entry[2] || !entry[4] || !isSafeGitPath(entry[4]))
        throw new Error("Invalid path in immutable Git tree")
      return {
        kind: entry[1],
        sha: entry[2],
        path: entry[4],
        size:
          entry[3] === undefined || entry[3] === "-" ? null : Number(entry[3]),
      }
    })
}

async function gitShowBytes(
  dir: string,
  path: string,
  fetchBlobs?: (shas: readonly string[]) => Promise<void>,
): Promise<GitShaFile> {
  if (!isSafeGitPath(path)) return { kind: "missing" }
  const entry = (
    await listTreeEntries(dir, fetchBlobs ? path : undefined)
  ).find((candidate) => candidate.kind === "blob" && candidate.path === path)
  if (!entry) return { kind: "missing" }
  await fetchBlobs?.([entry.sha])
  const { stdout } = await gitExec(
    ["-C", dir, "--no-lazy-fetch", "cat-file", "blob", entry.sha],
    {
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  )
  return { kind: "bytes", bytes: stdout }
}

/**
 * The blob paths below `folders` in the tree of `sha`, relative to the
 * Workspace root folder. The fetch gets only the trees, not the blobs.
 */
export async function listGitPathsAtSha(input: {
  url: string
  sha: string
  token?: string
  /** Folders relative to the Workspace root folder (`sources`). */
  folders: readonly string[]
  /** Workspace root folder; `""` or absent is the repository root. */
  root?: string
}): Promise<string[]> {
  return withFetchedGitSha({ ...input, treesOnly: true }, async (dir) => {
    const base = input.root ? `${input.root}/` : ""
    const { stdout } = await gitExec(
      [
        "-C",
        dir,
        "--no-lazy-fetch",
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        "--full-tree",
        "FETCH_HEAD",
        "--",
        ...input.folders.map((folder) => `${base}${folder}`),
      ],
      { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
    )
    return stdout
      .toString("utf8")
      .split("\0")
      .flatMap((path) => {
        const relative = path
          ? workspaceRelativePath(input.root ?? "", path)
          : null
        return relative === null ? [] : [relative]
      })
  })
}

/**
 * One history walk for the Markdown paths of `revs`, newest first: the
 * newest commit that added each repository path, and the newest commit that
 * added or changed it. Each path (relative to `root`) that a commit deleted
 * goes to `deletedPaths`, except the deletes of a layout commit.
 */
async function walkMarkdownHistory(
  dir: string,
  revs: readonly string[],
  input: { root?: string; layoutPath?: string; deletedPaths?: Set<string> },
): Promise<{
  introduced: Map<string, string>
  lastChanged: Map<string, string>
}> {
  const introduced = new Map<string, string>()
  const lastChanged = new Map<string, string>()
  const layoutPath = input.layoutPath
    ? workspaceRepositoryPath(input.root ?? "", input.layoutPath)
    : undefined
  // Raw -z keeps tabs/newlines in filenames intact.
  const history = await gitOutput(
    [
      "-C",
      dir,
      "--no-lazy-fetch",
      "log",
      "--topo-order",
      "--format=%x00%ct",
      "--raw",
      "-z",
      // Adds give the introducing commit; edits give the last change;
      // deletes give the deleted paths.
      "--diff-filter=AMTD",
      "--no-renames",
      ...revs,
      "--",
      "*.md",
      ...(layoutPath ? [`:(literal)${layoutPath}`] : []),
    ],
    5 * 60_000,
  )
  const records = history.toString("utf8").split("\0")
  let timestamp: string | undefined
  // The deletes of the current commit, kept until the commit ends.
  let deletes: string[] = []
  let layoutCommit = false
  const endCommit = () => {
    if (!layoutCommit)
      for (const path of deletes) {
        const relative = workspaceRelativePath(input.root ?? "", path)
        if (relative !== null) input.deletedPaths?.add(relative)
      }
    deletes = []
    layoutCommit = false
  }
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? ""
    if (/^[0-9]+$/.test(record)) {
      endCommit()
      timestamp = new Date(Number(record) * 1000).toISOString()
    } else {
      const status =
        /^\n?:[0-7]{6} [0-7]{6} [0-9a-f]+ [0-9a-f]+ ([A-Z])[0-9]*$/.exec(
          record,
        )?.[1]
      if (status) {
        const path = records[++i]
        if (!path || !timestamp)
          throw new Error("Invalid introducing-commit record")
        if (path === layoutPath) {
          layoutCommit = true
          continue
        }
        if (status === "D") {
          deletes.push(path)
          continue
        }
        if (!lastChanged.has(path)) lastChanged.set(path, timestamp)
        if (status === "A" && !introduced.has(path))
          introduced.set(path, timestamp)
      } else if (record) throw new Error("Invalid Git history response")
    }
  }
  endCommit()
  return { introduced, lastChanged }
}

/** Read markdown at a stored SHA from any git host. Token never logged. */
export async function listMarkdownFilesAtGitSha(input: {
  url: string
  sha: string
  token?: string
  includeIntroducingCommits?: boolean
  /**
   * With `includeIntroducingCommits`, the same history walk adds to this set
   * each Markdown path (relative to `root`) that a commit deleted.
   */
  deletedPaths?: Set<string>
  /**
   * A path (relative to `root`) whose change marks a layout commit, such as
   * an upgrade or its revert. The deletes of such a commit do not go to
   * `deletedPaths`, because a person did not delete those files.
   */
  layoutPath?: string
  /** Exact non-Markdown paths to read in the same fetch. */
  extraPaths?: readonly string[]
  /** Folders (`sources/`) whose every blob to read, also a non-Markdown one. */
  extraFolders?: readonly string[]
  /**
   * The largest blob in `extraFolders` to read. A larger blob, or one that is
   * not text, comes back with empty content and the reason in `omitted`.
   */
  extraFolderMaxBytes?: number
  /**
   * Read only the files under this folder (`sources/`). The fetch then gets
   * the trees and only the blobs under the folder.
   */
  prefix?: string
  /**
   * Workspace root folder. Only files below it are read, and every path
   * (including `extraPaths`, `extraFolders` and `prefix`) is relative to it.
   */
  root?: string
  /** More Git work in the same directory, after the read. */
  inspect?: (session: GitReadSession) => Promise<void>
}): Promise<
  Array<{
    path: string
    content: string
    omitted?: "too_large" | "binary"
    introducingCommitTimestamp?: string
    /** Time of the newest commit that changed the path. */
    lastCommitTimestamp?: string
  }>
> {
  const { prefix } = input
  return withFetchedGitSha(
    { ...input, treesOnly: !!prefix },
    async (dir, fetchBlobs) => {
      const inFolder = (path: string) =>
        input.extraFolders?.some((folder) => path.startsWith(folder)) ?? false
      const listed = (
        await listTreeEntries(
          dir,
          prefix ? `${input.root ? `${input.root}/` : ""}${prefix}` : undefined,
        )
      ).flatMap((entry) => {
        const path = workspaceRelativePath(input.root ?? "", entry.path)
        return path !== null &&
          entry.kind === "blob" &&
          (!prefix || path.startsWith(prefix)) &&
          (path.endsWith(".md") ||
            input.extraPaths?.includes(path) ||
            inFolder(path))
          ? [{ ...entry, repositoryPath: entry.path, path }]
          : []
      })
      // Check the size before the read, so a large blob is never in memory.
      const tooLarge = (entry: (typeof listed)[number]) =>
        input.extraFolderMaxBytes !== undefined &&
        inFolder(entry.path) &&
        (entry.size ?? 0) > input.extraFolderMaxBytes
      const omitted = listed.filter(tooLarge).map((entry) => ({
        path: entry.path,
        content: "",
        omitted: "too_large" as const,
      }))
      const entries = listed.filter((entry) => !tooLarge(entry))
      if (entries.length === 0) return omitted
      await fetchBlobs(entries.map((entry) => entry.sha))
      const blobs = await readGitBlobs(
        dir,
        entries.map((entry) => entry.sha),
      )
      const { introduced, lastChanged } = input.includeIntroducingCommits
        ? await walkMarkdownHistory(dir, ["FETCH_HEAD"], input)
        : { introduced: new Map<string, string>(), lastChanged: new Map() }
      const read = entries.map((entry, index) => {
        const bytes = blobs[index] ?? Buffer.alloc(0)
        if (
          input.extraFolderMaxBytes !== undefined &&
          inFolder(entry.path) &&
          bytes.includes(0)
        )
          return { path: entry.path, content: "", omitted: "binary" as const }
        return {
          path: entry.path,
          content: bytes.toString("utf8"),
          ...(introduced.has(entry.repositoryPath)
            ? {
                introducingCommitTimestamp: introduced.get(
                  entry.repositoryPath,
                ),
              }
            : {}),
          ...(lastChanged.has(entry.repositoryPath)
            ? { lastCommitTimestamp: lastChanged.get(entry.repositoryPath) }
            : {}),
        }
      })
      await input.inspect?.({
        directory: dir,
        fetchObjects: sessionFetch(dir, input),
      })
      return [...read, ...omitted]
    },
  )
}

/** List every file path at a stored SHA. Token never logged. */
export async function listPathsAtGitSha(input: {
  url: string
  sha: string
  token?: string
}): Promise<string[]> {
  return withFetchedGitSha(input, async (dir) =>
    (await listTreeEntries(dir)).map((entry) => entry.path),
  )
}

/**
 * Read one file at a stored SHA. Token never logged. With `treesOnly`, the
 * fetch gets the trees and only the blob of this file.
 */
export async function readFileAtGitSha(input: {
  url: string
  sha: string
  path: string
  token?: string
  treesOnly?: boolean
}): Promise<GitShaFile> {
  return withFetchedGitSha(input, (dir, fetchBlobs) =>
    gitShowBytes(dir, input.path, input.treesOnly ? fetchBlobs : undefined),
  )
}

/**
 * A Git directory of a read that stays open for `inspect`: the caller can run
 * more Git commands in it (for example the history of the write planner).
 */
export type GitReadSession = {
  directory: string
  /**
   * Fetch the commits (with their trees, without blobs) or the blobs that the
   * directory does not have yet. The fetch uses the read credential; the
   * directory keeps no credential.
   */
  fetchObjects: (shas: readonly string[]) => Promise<void>
}

/** `fetchObjects` of a read directory, in one Git command for all objects. */
function sessionFetch(
  dir: string,
  input: { url: string; token?: string },
): GitReadSession["fetchObjects"] {
  return async (shas) => {
    if (!shas.length) return
    const missing = (
      await gitOutput(
        ["-C", dir, "--no-lazy-fetch", "cat-file", "--batch-check"],
        60_000,
        `${shas.join("\n")}\n`,
      )
    )
      .toString("utf8")
      .split("\n")
      .flatMap((line) => {
        const [sha, state] = line.split(" ")
        return sha && state === "missing" ? [sha] : []
      })
    if (!missing.length) return
    await gitExec(
      [
        // The settings apply to this command only.
        "-c",
        "remote.origin.promisor=true",
        "-c",
        "remote.origin.partialclonefilter=blob:none",
        "-C",
        dir,
        "fetch",
        "--no-tags",
        "--filter=blob:none",
        "origin",
        ...missing,
      ],
      { timeout: 60_000, env: gitRemoteEnvironment(input) },
    )
  }
}

/**
 * The Markdown files of `sha` that differ from `baseSha`, or that a commit
 * between the two touched, and the files that `alsoRead` selects. The fetch
 * gets the trees of the two commits and of the commits between them, and
 * only the blobs that the read needs, so the read does not grow with the
 * size of the tree. Returns null when `baseSha` is not an ancestor of `sha`
 * within the history depth that the read fetches: then the times of the
 * changed files are not known from the commits between the two SHAs.
 */
export async function readGitChangesSinceSha(input: {
  url: string
  sha: string
  baseSha: string
  token?: string
  /** Workspace root folder. Every path is relative to it. */
  root?: string
  /** Paths (relative to `root`) to read at `sha` also when they did not change. */
  alsoRead: (path: string) => boolean
  /** Folders (`sources/`) whose blobs above `extraFolderMaxBytes` are omitted. */
  extraFolders?: readonly string[]
  extraFolderMaxBytes?: number
  /** More Git work in the same directory, after the read. */
  inspect?: (session: GitReadSession) => Promise<void>
}): Promise<{
  files: Array<{
    path: string
    content: string
    omitted?: "too_large" | "binary"
    introducingCommitTimestamp?: string
    lastCommitTimestamp?: string
  }>
  /** Every blob path of `sha` below the root folder. */
  paths: string[]
  /** The Markdown paths that the read selected because they changed. */
  changed: string[]
  /** The Markdown paths of `baseSha` that `sha` does not have. */
  removed: string[]
} | null> {
  for (const sha of [input.sha, input.baseSha])
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))
      throw new Error("A full immutable Git commit SHA is required")
  const env = gitRemoteEnvironment(input)
  const root = input.root ?? ""
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-hydrate-changes-"))
  try {
    await initGitReadDirectory(dir, { ...input, treesOnly: true })
    const fetch = (depth: number, shas: readonly string[]) =>
      gitExec(
        [
          "-C",
          dir,
          "fetch",
          "--no-tags",
          "--filter=blob:none",
          "--depth",
          String(depth),
          "origin",
          ...shas,
        ],
        { timeout: 60_000, env },
      )
    // Most runs hydrate a few commits, so the first fetch gets 32 commits.
    // A deeper fetch comes only when the base is farther away.
    await timedGit("git.fetch-changes", () =>
      fetch(32, [input.sha, input.baseSha]),
    )
    // Git offers only the commits that a ref names as "have". With these
    // refs, a deeper fetch and each later fetch of the read do not get the
    // fetched trees again.
    for (const [ref, sha] of [
      ["refs/hydrate/tip", input.sha],
      ["refs/hydrate/base", input.baseSha],
    ] as const)
      await gitExec(["-C", dir, "update-ref", ref, sha], { timeout: 15_000 })
    if (!(await completeRange(dir, input.baseSha, input.sha))) {
      await timedGit("git.fetch-changes-history", () => fetch(512, [input.sha]))
      if (!(await completeRange(dir, input.baseSha, input.sha))) return null
    }

    const { introduced, lastChanged } = await walkMarkdownHistory(
      dir,
      [`${input.baseSha}..${input.sha}`],
      { root },
    )
    const diff = (
      await gitOutput(
        [
          "-C",
          dir,
          "--no-lazy-fetch",
          "diff-tree",
          "-r",
          "-z",
          "--no-renames",
          "--name-status",
          input.baseSha,
          input.sha,
        ],
        60_000,
      )
    )
      .toString("utf8")
      .split("\0")
    const differs = new Set<string>()
    const removed: string[] = []
    for (let i = 0; i + 1 < diff.length; i += 2) {
      const status = diff[i] ?? ""
      const path = workspaceRelativePath(root, diff[i + 1] ?? "")
      if (path === null || !path.endsWith(".md")) continue
      if (status === "D") removed.push(path)
      else differs.add(path)
    }
    const entries = (
      await gitOutput(
        [
          "-C",
          dir,
          "--no-lazy-fetch",
          "ls-tree",
          "-rz",
          "--full-tree",
          input.sha,
        ],
        60_000,
      )
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .flatMap((record) => {
        const entry = /^\d+ (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record)
        if (!entry?.[1] || !entry[2] || !entry[3] || !isSafeGitPath(entry[3]))
          throw new Error("Invalid path in immutable Git tree")
        const path = workspaceRelativePath(root, entry[3])
        return entry[1] === "blob" && path !== null
          ? [{ sha: entry[2], path, repositoryPath: entry[3] }]
          : []
      })
    const changed = entries.filter(
      (entry) =>
        entry.path.endsWith(".md") &&
        (differs.has(entry.path) || lastChanged.has(entry.repositoryPath)),
    )
    const changedPaths = new Set(changed.map((entry) => entry.path))
    const selected = entries.filter(
      (entry) => changedPaths.has(entry.path) || input.alsoRead(entry.path),
    )
    const session: GitReadSession = {
      directory: dir,
      fetchObjects: sessionFetch(dir, input),
    }
    await session.fetchObjects([...new Set(selected.map((entry) => entry.sha))])
    const inFolder = (path: string) =>
      input.extraFolders?.some((folder) => path.startsWith(folder)) ?? false
    const maxBytes = input.extraFolderMaxBytes
    // Check the size before the read, so a large blob is never in memory.
    const sizes =
      maxBytes === undefined
        ? new Map<string, number>()
        : await blobSizes(
            dir,
            selected
              .filter((entry) => inFolder(entry.path))
              .map((entry) => entry.sha),
          )
    const tooLarge = (entry: (typeof selected)[number]) =>
      maxBytes !== undefined &&
      inFolder(entry.path) &&
      (sizes.get(entry.sha) ?? 0) > maxBytes
    const readable = selected.filter((entry) => !tooLarge(entry))
    const contents = await readGitBlobs(
      dir,
      readable.map((entry) => entry.sha),
    )
    const blobs = new Map(
      readable.map((entry, index) => [entry.sha, contents[index]]),
    )
    const files = selected.map((entry) => {
      if (tooLarge(entry))
        return { path: entry.path, content: "", omitted: "too_large" as const }
      const bytes = blobs.get(entry.sha) ?? Buffer.alloc(0)
      if (maxBytes !== undefined && inFolder(entry.path) && bytes.includes(0))
        return { path: entry.path, content: "", omitted: "binary" as const }
      const introducedAt = introduced.get(entry.repositoryPath)
      const lastChangedAt = lastChanged.get(entry.repositoryPath)
      return {
        path: entry.path,
        content: bytes.toString("utf8"),
        ...(introducedAt ? { introducingCommitTimestamp: introducedAt } : {}),
        ...(lastChangedAt ? { lastCommitTimestamp: lastChangedAt } : {}),
      }
    })
    await input.inspect?.(session)
    return {
      files,
      paths: entries.map((entry) => entry.path),
      changed: [...changedPaths],
      removed,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The size of each blob of `shas` that the directory has. */
async function blobSizes(
  dir: string,
  shas: readonly string[],
): Promise<Map<string, number>> {
  if (shas.length === 0) return new Map()
  return new Map(
    (
      await gitOutput(
        ["-C", dir, "--no-lazy-fetch", "cat-file", "--batch-check"],
        60_000,
        `${shas.join("\n")}\n`,
      )
    )
      .toString("utf8")
      .split("\n")
      .flatMap((line) => {
        const [sha, kind, size] = line.split(" ")
        return sha && kind === "blob" ? [[sha, Number(size)] as const] : []
      }),
  )
}

/**
 * True when `base` is an ancestor of `tip` in the fetched history, and no
 * commit between them is cut by the shallow boundary. A cut commit has no
 * parents in the directory, so its diff would show each file as added.
 */
async function completeRange(
  dir: string,
  base: string,
  tip: string,
): Promise<boolean> {
  if (base === tip) return true
  const ancestor = await gitExec(
    ["-C", dir, "--no-lazy-fetch", "merge-base", "--is-ancestor", base, tip],
    { timeout: 60_000 },
  ).then(
    () => true,
    () => false,
  )
  if (!ancestor) return false
  const shallow = new Set(
    (
      await readFile(join(dir, ".git/shallow"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return ""
          throw error
        },
      )
    )
      .split("\n")
      .filter(Boolean),
  )
  const range = (
    await gitOutput(
      ["-C", dir, "--no-lazy-fetch", "rev-list", `${base}..${tip}`],
      60_000,
    )
  )
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
  return range.every((sha) => !shallow.has(sha))
}
