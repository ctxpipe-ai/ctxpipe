import { execFile, spawn } from "node:child_process"
import { mkdtemp, open, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
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
    const execution = execFileAsync("git", args, {
      ...options,
      encoding: "buffer",
    })
    if (input !== undefined) execution.child.stdin?.end(input)
    return await execution
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
    `Git ${command} did not finish in the time that ctx| waits (${Math.round(timeout / 1000)} s).`,
  )
}

/**
 * Run Git with its standard output in a temporary file, then read the file.
 * The output of these commands grows with the repository, and a buffered
 * standard output has a fixed limit (CTX-933).
 */
async function gitOutput(
  args: string[],
  timeout: number,
  input?: string,
): Promise<Buffer> {
  const scratch = await mkdtemp(join(tmpdir(), "ctxpipe-git-output-"))
  try {
    const file = join(scratch, "stdout")
    const stdout = await open(file, "w")
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("git", args, {
          stdio: [input === undefined ? "ignore" : "pipe", stdout.fd, "pipe"],
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
                new Error(`Command failed: git ${args.join(" ")}\n${stderr}`),
                { code, stderr },
              ),
            )
        })
      })
    } finally {
      await stdout.close()
    }
    return await readFile(file)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

type GitShaFile = { kind: "missing" } | { kind: "bytes"; bytes: Uint8Array }

export const GIT_REMOTE_ACCESS_MESSAGES = {
  noCredential:
    "ctx| has no access to this repository. Connect GitHub to this Workspace, then retry.",
  denied:
    "ctx| has no access to this repository. Add the repository to the GitHub App installation, then refresh.",
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
    if (input.treesOnly) {
      const config = ["-C", dir, "config"]
      await gitExec([...config, "remote.origin.promisor", "true"], {
        timeout: 15_000,
      })
      await gitExec(
        [...config, "remote.origin.partialclonefilter", "blob:none"],
        {
          timeout: 15_000,
        },
      )
    }
    // A remote without filter support sends every blob; the read still works.
    const filter = input.treesOnly ? ["--filter=blob:none"] : []
    await gitExec(
      [
        "-C",
        dir,
        "fetch",
        ...filter,
        ...(input.includeIntroducingCommits ? [] : ["--depth", "1"]),
        "origin",
        input.sha,
      ],
      {
        // The full history of a large repository takes much longer than
        // its newest commit.
        timeout: input.includeIntroducingCommits ? 10 * 60_000 : 60_000,
        env,
      },
    )
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
      "ls-tree",
      "-rlz",
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
      const entry = /^\d+ (\w+) ([0-9a-f]+) +(\d+|-)\t([\s\S]+)$/.exec(record)
      if (
        !entry?.[1] ||
        !entry[2] ||
        !entry[3] ||
        !entry[4] ||
        !isSafeGitPath(entry[4])
      )
        throw new Error("Invalid path in immutable Git tree")
      return {
        kind: entry[1],
        sha: entry[2],
        path: entry[4],
        size: entry[3] === "-" ? null : Number(entry[3]),
      }
    })
}

async function gitShowBytes(dir: string, path: string): Promise<GitShaFile> {
  if (!isSafeGitPath(path)) return { kind: "missing" }
  const entry = (await listTreeEntries(dir)).find(
    (candidate) => candidate.kind === "blob" && candidate.path === path,
  )
  if (!entry) return { kind: "missing" }
  const { stdout } = await gitExec(["-C", dir, "cat-file", "blob", entry.sha], {
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  })
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
      // The caller keeps all blob contents in memory.
      const stdout = await gitOutput(
        ["-C", dir, "cat-file", "--batch"],
        60_000,
        `${entries.map((entry) => entry.sha).join("\n")}\n`,
      )
      const introduced = new Map<string, string>()
      const lastChanged = new Map<string, string>()
      if (input.includeIntroducingCommits) {
        const layoutPath = input.layoutPath
          ? workspaceRepositoryPath(input.root ?? "", input.layoutPath)
          : undefined
        // One history walk for all paths, newest first; raw -z keeps tabs/newlines in filenames intact.
        const history = await gitOutput(
          [
            "-C",
            dir,
            "log",
            "--topo-order",
            "--format=%x00%ct",
            "--raw",
            "-z",
            // Adds give the introducing commit; edits give the last change;
            // deletes give the deleted paths.
            "--diff-filter=AMTD",
            "--no-renames",
            "FETCH_HEAD",
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
      }
      let offset = 0
      const read = entries.map((entry) => {
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
          sha !== entry.sha ||
          kind !== "blob" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          end >= stdout.length ||
          stdout[end] !== 10
        )
          throw new Error("Invalid blob in immutable Git batch")
        offset = end + 1
        const bytes = stdout.subarray(start, end)
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

/** Read one file at a stored SHA. Token never logged. */
export async function readFileAtGitSha(input: {
  url: string
  sha: string
  path: string
  token?: string
}): Promise<GitShaFile> {
  return withFetchedGitSha(input, (dir) => gitShowBytes(dir, input.path))
}
