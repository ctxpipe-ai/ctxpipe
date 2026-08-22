import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

async function gitExec(
  args: string[],
  options: Parameters<typeof execFileAsync>[2] = {},
) {
  try {
    return await execFileAsync("git", args, options)
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

function authenticatedGitUrl(url: string, token?: string): string {
  if (!token) return url
  try {
    const parsed = new URL(url)
    parsed.username = "x-access-token"
    parsed.password = token
    return parsed.toString()
  } catch {
    return url
  }
}

function isSafeGitPath(path: string): boolean {
  if (!path || path.includes("\0")) return false
  const parts = path.replace(/\\/g, "/").split("/")
  return parts.every((part) => part !== "" && part !== "." && part !== "..")
}

async function withFetchedGitSha<T>(
  input: { url: string; sha: string; token?: string },
  read: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-hydrate-"))
  const remote = authenticatedGitUrl(input.url, input.token)
  try {
    await gitExec(["init", dir], { timeout: 15_000 })
    await gitExec(["-C", dir, "remote", "add", "origin", remote], {
      timeout: 15_000,
    })
    await gitExec(["-C", dir, "fetch", "--depth", "1", "origin", input.sha], {
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return await read(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function listTreePaths(dir: string): Promise<string[]> {
  const { stdout } = await gitExec(
    ["-C", dir, "ls-tree", "-r", "--name-only", "FETCH_HEAD"],
    { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
  )
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((path) => path.length > 0 && isSafeGitPath(path))
}

async function gitShowBytes(dir: string, path: string): Promise<GitShaFile> {
  if (!isSafeGitPath(path)) return { kind: "missing" }
  try {
    const { stdout } = await gitExec(["-C", dir, "show", `FETCH_HEAD:${path}`], {
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { kind: "bytes", bytes: stdout }
  } catch {
    return { kind: "missing" }
  }
}

/** Read markdown at a stored SHA from any git host. Token never logged. */
export async function listMarkdownFilesAtGitSha(input: {
  url: string
  sha: string
  token?: string
}): Promise<Array<{ path: string; content: string }>> {
  return withFetchedGitSha(input, async (dir) => {
    const files: Array<{ path: string; content: string }> = []
    for (const path of await listTreePaths(dir)) {
      if (!path.endsWith(".md")) continue
      const file = await gitShowBytes(dir, path)
      if (file.kind !== "bytes") continue
      files.push({ path, content: file.bytes.toString("utf8") })
    }
    return files
  })
}

/** List every file path at a stored SHA. Token never logged. */
export async function listPathsAtGitSha(input: {
  url: string
  sha: string
  token?: string
}): Promise<string[]> {
  return withFetchedGitSha(input, (dir) => listTreePaths(dir))
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
