import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

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
    const err = error as NodeJS.ErrnoException & { message?: string }
    if (
      err.code === "ENOENT" ||
      /not found in \$PATH/i.test(err.message ?? "")
    ) {
      throw new Error(
        "git is not installed on this service; cannot read a repository by clone.",
      )
    }
    throw error
  }
}

export type GitShaFile =
  | { kind: "missing" }
  | { kind: "bytes"; bytes: Uint8Array }

/** Resolve a branch once; subsequent reads fetch the returned immutable SHA. */
export async function resolveGitRemoteTip(input: {
  url: string
  branch?: string | null
  token?: string
}): Promise<{ sha: string; branch: string } | null> {
  const requested = input.branch?.trim()
  const ref = requested ? `refs/heads/${requested}` : "HEAD"
  const { stdout } = await gitExec(
    ["ls-remote", "--symref", "--", input.url, ref],
    { timeout: 60_000, env: gitReadEnvironment(input) },
  )
  const lines = stdout.toString("utf8").trim().split("\n")
  const sha = lines
    .map((line) => line.split("\t"))
    .find(
      ([value, name]) =>
        name === ref && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value ?? ""),
    )?.[0]
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

function gitReadEnvironment(input: {
  url: string
  token?: string
}): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
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
  },
  read: (dir: string) => Promise<T>,
): Promise<T> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.sha))
    throw new Error("A full immutable Git commit SHA is required")
  const env = gitReadEnvironment(input)
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-hydrate-"))
  try {
    await gitExec(["init", dir], { timeout: 15_000 })
    await gitExec(["-C", dir, "remote", "add", "origin", input.url], {
      timeout: 15_000,
    })
    await gitExec(
      [
        "-C",
        dir,
        "fetch",
        ...(input.includeIntroducingCommits ? [] : ["--depth", "1"]),
        "origin",
        input.sha,
      ],
      {
        timeout: 60_000,
        env,
      },
    )
    return await read(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function listTreeEntries(
  dir: string,
): Promise<Array<{ kind: string; sha: string; path: string }>> {
  const { stdout } = await gitExec(
    ["-C", dir, "ls-tree", "-rz", "--full-tree", "FETCH_HEAD"],
    { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
  )
  return stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const entry = /^\d+ (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record)
      if (!entry?.[1] || !entry[2] || !entry[3] || !isSafeGitPath(entry[3]))
        throw new Error("Invalid path in immutable Git tree")
      return { kind: entry[1], sha: entry[2], path: entry[3] }
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

/** Read markdown at a stored SHA from any git host. Token never logged. */
export async function listMarkdownFilesAtGitSha(input: {
  url: string
  sha: string
  token?: string
  includeIntroducingCommits?: boolean
}): Promise<
  Array<{ path: string; content: string; introducingCommitTimestamp?: string }>
> {
  return withFetchedGitSha(input, async (dir) => {
    const entries = (await listTreeEntries(dir)).filter(
      (entry) => entry.kind === "blob" && entry.path.endsWith(".md"),
    )
    if (entries.length === 0) return []
    const { stdout } = await gitExec(
      ["-C", dir, "cat-file", "--batch"],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      `${entries.map((entry) => entry.sha).join("\n")}\n`,
    )
    const introduced = new Map<string, string>()
    if (input.includeIntroducingCommits) {
      // One history walk for all paths; raw -z keeps tabs/newlines in filenames intact.
      const { stdout: history } = await gitExec(
        [
          "-C",
          dir,
          "log",
          "--topo-order",
          "--format=%x00%ct",
          "--raw",
          "-z",
          "--diff-filter=A",
          "--no-renames",
          "FETCH_HEAD",
          "--",
          "*.md",
        ],
        { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      )
      const records = history.toString("utf8").split("\0")
      let timestamp: string | undefined
      for (let i = 0; i < records.length; i++) {
        const record = records[i] ?? ""
        if (/^[0-9]+$/.test(record))
          timestamp = new Date(Number(record) * 1000).toISOString()
        else if (/^\n?:[0-7]{6} [0-7]{6} [0-9a-f]+ [0-9a-f]+ A$/.test(record)) {
          const path = records[++i]
          if (!path || !timestamp)
            throw new Error("Invalid introducing-commit record")
          if (!introduced.has(path)) introduced.set(path, timestamp)
        } else if (record) throw new Error("Invalid Git history response")
      }
    }
    let offset = 0
    return entries.map((entry) => {
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
      return {
        path: entry.path,
        content: stdout.subarray(start, end).toString("utf8"),
        ...(introduced.has(entry.path)
          ? { introducingCommitTimestamp: introduced.get(entry.path) }
          : {}),
      }
    })
  })
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
