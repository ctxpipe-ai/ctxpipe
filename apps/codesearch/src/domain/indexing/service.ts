import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { ZOEKT_INDEX_DIR } from "../../config/paths.js"

type IndexInput = {
  repoGitUrl: string
  clonePath: string
  githubToken?: string
  zoektRepoId: number
  repoName: string
  repoUrl: string
}

function isGitHubUrl(gitUrl: string): boolean {
  if (gitUrl.startsWith("git@github.com:")) return true
  try {
    const parsed = new URL(gitUrl)
    return parsed.hostname === "github.com"
  } catch {
    return false
  }
}

async function runCommand(
  cmd: string[],
  options?: {
    cwd?: string
    env?: Record<string, string | undefined>
  },
): Promise<void> {
  const subprocess = Bun.spawn(cmd, {
    cwd: options?.cwd,
    env: options?.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      [
        `Command failed with exit code ${exitCode}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : "",
        stdout.trim() ? `stdout: ${stdout.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }
}

async function cloneRepository(params: {
  repoGitUrl: string
  clonePath: string
  githubToken?: string
}): Promise<void> {
  await rm(params.clonePath, { recursive: true, force: true })
  await mkdir(dirname(params.clonePath), { recursive: true })
  const authArgs =
    params.githubToken && isGitHubUrl(params.repoGitUrl)
      ? [
          "-c",
          `http.extraHeader=Authorization: Bearer ${params.githubToken}`,
        ]
      : []
  await runCommand([
    "git",
    ...authArgs,
    "clone",
    "--depth",
    "1",
    params.repoGitUrl,
    params.clonePath,
  ])
}

async function indexRepository(params: {
  clonePath: string
  zoektRepoId: number
  repoName: string
  repoUrl: string
}): Promise<void> {
  await mkdir(ZOEKT_INDEX_DIR, { recursive: true })
  const metaPath = `/tmp/zoekt-meta-${randomUUID()}.json`
  const metadata = {
    ID: params.zoektRepoId,
    Name: params.repoName,
    URL: params.repoUrl,
    Source: params.clonePath,
  }
  await writeFile(metaPath, JSON.stringify(metadata))
  try {
    await runCommand([
      "zoekt-index",
      "-index",
      ZOEKT_INDEX_DIR,
      "-meta",
      metaPath,
      params.clonePath,
    ])
  } finally {
    await rm(metaPath, { force: true })
  }
}

export async function cloneAndIndexRepository(input: IndexInput): Promise<void> {
  await cloneRepository({
    repoGitUrl: input.repoGitUrl,
    clonePath: input.clonePath,
    githubToken: input.githubToken,
  })
  await indexRepository({
    clonePath: input.clonePath,
    zoektRepoId: input.zoektRepoId,
    repoName: input.repoName,
    repoUrl: input.repoUrl,
  })
}
