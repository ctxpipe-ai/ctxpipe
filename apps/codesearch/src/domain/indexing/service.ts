import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { and, eq } from "drizzle-orm"
import { ZOEKT_INDEX_DIR } from "../../config/paths.js"
import type { Db } from "../../db/client.js"
import { repositoryCheckouts } from "../../db/schema.js"
import { authenticatedGitUrl } from "../../utils/git.js"
import { DEFAULT_CHECKOUT_KEY } from "../repositories/paths.js"

type IndexInput = {
  db: Db
  repoId: string
  repoGitUrl: string
  clonePath: string
  githubToken?: string
  zoektRepoId: number
  repoName: string
  repoUrl: string
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
  await runCommand([
    "git",
    "clone",
    "--depth",
    "1",
    authenticatedGitUrl(params.repoGitUrl, params.githubToken),
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

const ZOEKT_INDEX_FINGERPRINT_VERSION = "1"

async function readGitHead(clonePath: string): Promise<string | null> {
  const subprocess = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: clonePath,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(subprocess.stdout).text()
  const exitCode = await subprocess.exited
  if (exitCode !== 0) return null
  const sha = stdout.trim()
  return sha.length > 0 ? sha : null
}

function zoektIndexFingerprint(commitSha: string | null): string {
  return `v${ZOEKT_INDEX_FINGERPRINT_VERSION}:zoekt:${commitSha ?? "unknown"}`
}

async function markCheckoutZoektIndexed(
  db: Db,
  repositoryId: string,
  commitSha: string | null,
): Promise<void> {
  const fp = zoektIndexFingerprint(commitSha)
  const composite =
    commitSha != null ? `v${ZOEKT_INDEX_FINGERPRINT_VERSION}:${commitSha}` : fp
  await db
    .update(repositoryCheckouts)
    .set({
      commitSha,
      zoektIndexReady: true,
      zoektIndexFingerprint: fp,
      indexFingerprint: composite,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositoryCheckouts.repositoryId, repositoryId),
        eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
      ),
    )
}

export async function cloneAndIndexRepository(
  input: IndexInput,
): Promise<void> {
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
  const head = await readGitHead(input.clonePath)
  await markCheckoutZoektIndexed(input.db, input.repoId, head)
}
