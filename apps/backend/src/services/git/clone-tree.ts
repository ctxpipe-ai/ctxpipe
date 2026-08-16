import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

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

async function walkMarkdown(
  root: string,
  relative = "",
): Promise<Array<{ path: string; content: string }>> {
  const dir = relative ? join(root, relative) : root
  const entries = await readdir(dir, { withFileTypes: true })
  const files: Array<{ path: string; content: string }> = []
  for (const entry of entries) {
    if (entry.name === ".git") continue
    const next = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdown(root, next)))
      continue
    }
    if (!entry.name.endsWith(".md")) continue
    files.push({
      path: next,
      content: await readFile(join(root, next), "utf8"),
    })
  }
  return files
}

/** Read markdown at a stored SHA from any git host. Token never logged. */
export async function listMarkdownFilesAtGitSha(input: {
  url: string
  sha: string
  token?: string
}): Promise<Array<{ path: string; content: string }>> {
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-hydrate-"))
  const remote = authenticatedGitUrl(input.url, input.token)
  try {
    await execFileAsync("git", ["init", dir], { timeout: 15_000 })
    await execFileAsync("git", ["-C", dir, "remote", "add", "origin", remote], {
      timeout: 15_000,
    })
    await execFileAsync(
      "git",
      ["-C", dir, "fetch", "--depth", "1", "origin", input.sha],
      { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    )
    await execFileAsync("git", ["-C", dir, "checkout", "FETCH_HEAD"], {
      timeout: 15_000,
    })
    return walkMarkdown(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
