import { randomUUID } from "node:crypto"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { and, eq } from "drizzle-orm"
import { ZOEKT_INDEX_DIR } from "../../config/paths.js"
import type { Db } from "../../db/client.js"
import { repositoryCheckouts } from "../../db/schema.js"
import { authenticatedGitUrl } from "../../utils/git.js"
import { DEFAULT_CHECKOUT_KEY } from "../repositories/paths.js"
import { resolveRepositoryRef } from "../repositories/resolveRef.js"
import { cgcIndexArgsForIngestMode } from "./cgcIndex.js"
import { ensureCgcWatchBeforeCheckout } from "./cgcWatchRegistry.js"

type IndexInput = {
  db: Db
  orgId: string
  repoId: string
  repoGitUrl: string
  clonePath: string
  kuzuDbPath: string
  githubToken?: string
  zoektRepoId: number
  repoName: string
  repoUrl: string
  /** Commit SHA or ref to checkout before indexing. If omitted, default branch is resolved via remote. */
  targetHash?: string
  /** Optional previous indexed commit for partial ingestion metadata (diff + ancestor check). */
  fromHash?: string
}

export type IndexRepoResult = {
  targetHash: string
  ingestMode: "full" | "partial"
  changedPaths: string[]
  deletedPaths: string[]
  renames: { from: string; to: string }[]
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function hasGitDir(clonePath: string): Promise<boolean> {
  return pathExists(join(clonePath, ".git"))
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

async function runCommandOutput(
  cmd: string[],
  options?: {
    cwd?: string
    env?: Record<string, string | undefined>
  },
): Promise<string> {
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
  return stdout
}

async function ensureRepositoryClone(params: {
  repoGitUrl: string
  clonePath: string
  githubToken?: string
}): Promise<void> {
  const authUrl = authenticatedGitUrl(params.repoGitUrl, params.githubToken)
  if (await hasGitDir(params.clonePath)) {
    await runCommand(["git", "remote", "set-url", "origin", authUrl], {
      cwd: params.clonePath,
    })
    await runCommand(["git", "fetch", "origin", "--prune"], {
      cwd: params.clonePath,
    })
    return
  }
  await mkdir(dirname(params.clonePath), { recursive: true })
  if (await pathExists(params.clonePath)) {
    await rm(params.clonePath, { recursive: true, force: true })
  }
  await runCommand(["git", "clone", authUrl, params.clonePath])
}

async function ensureCommitInRepo(
  clonePath: string,
  refOrSha: string,
): Promise<string> {
  const trimmed = refOrSha.trim()
  try {
    await runCommand(["git", "rev-parse", "--verify", `${trimmed}^{commit}`], {
      cwd: clonePath,
    })
  } catch {
    await runCommand(["git", "fetch", "origin", trimmed], { cwd: clonePath })
    await runCommand(["git", "rev-parse", "--verify", `${trimmed}^{commit}`], {
      cwd: clonePath,
    })
  }
  const out = await runCommandOutput(["git", "rev-parse", trimmed], {
    cwd: clonePath,
  })
  return out.trim()
}

async function resolveTargetCommitHash(params: {
  repoGitUrl: string
  clonePath: string
  githubToken?: string
  targetHash?: string
}): Promise<string> {
  if (params.targetHash && params.targetHash.trim().length > 0) {
    return ensureCommitInRepo(params.clonePath, params.targetHash.trim())
  }
  const { hash } = await resolveRepositoryRef({
    gitUrl: params.repoGitUrl,
    githubToken: params.githubToken,
  })
  return ensureCommitInRepo(params.clonePath, hash)
}

async function checkoutCommit(
  clonePath: string,
  fullSha: string,
): Promise<void> {
  await runCommand(["git", "checkout", "-f", fullSha], { cwd: clonePath })
}

async function isAncestor(
  clonePath: string,
  fromSha: string,
  toSha: string,
): Promise<boolean> {
  const subprocess = Bun.spawn(
    ["git", "merge-base", "--is-ancestor", fromSha, toSha],
    {
      cwd: clonePath,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const exitCode = await subprocess.exited
  if (exitCode === 0) return true
  if (exitCode === 1) return false
  const stderr = await new Response(subprocess.stderr).text()
  throw new Error(
    `git merge-base --is-ancestor failed: ${stderr.trim() || `exit ${exitCode}`}`,
  )
}

function parseNameStatus(diffOutput: string): {
  changedPaths: string[]
  deletedPaths: string[]
  renames: { from: string; to: string }[]
} {
  const changedPaths: string[] = []
  const deletedPaths = new Set<string>()
  const renames: { from: string; to: string }[] = []
  for (const line of diffOutput.split("\n")) {
    if (!line.trim()) continue
    const tabParts = line.split("\t")
    if (tabParts.length < 2) continue
    const status = tabParts[0]
    if (status === undefined) continue
    const paths = tabParts.slice(1)
    const kind = status[0]
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = paths[0]
      const to = paths[1]
      if (from !== undefined && to !== undefined) {
        renames.push({ from, to })
        changedPaths.push(to)
        deletedPaths.add(from)
      }
      continue
    }
    if (kind === "D") {
      const p = paths[0]
      if (p !== undefined) deletedPaths.add(p)
      continue
    }
    if (kind === "A" || kind === "M" || kind === "T" || kind === "U") {
      const p = paths[0]
      if (p !== undefined) changedPaths.push(p)
    }
  }
  return { changedPaths, deletedPaths: [...deletedPaths], renames }
}

async function diffRangeNameStatus(params: {
  clonePath: string
  fromSha: string
  toSha: string
}): Promise<string> {
  return runCommandOutput(
    [
      "git",
      "diff",
      "--name-status",
      "-M",
      `${params.fromSha}..${params.toSha}`,
    ],
    { cwd: params.clonePath },
  )
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

async function runCgcIndexQuietly(params: {
  clonePath: string
  kuzuDbPath: string
  orgId: string
  repoId: string
  ingestMode: "full" | "partial"
}): Promise<void> {
  const { args, allowForceFallback } = cgcIndexArgsForIngestMode(
    params.ingestMode,
  )

  async function runCgc(cmd: string[]): Promise<number> {
    await mkdir(dirname(params.kuzuDbPath), { recursive: true })
    const subprocess = Bun.spawn(cmd, {
      cwd: params.clonePath,
      env: {
        ...process.env,
        KUZUDB_PATH: params.kuzuDbPath,
        DATABASE_TYPE: "kuzudb",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
    if (exitCode !== 0) {
      console.error("[codesearch] cgc index failed", {
        orgId: params.orgId,
        repoId: params.repoId,
        exitCode,
        kuzuDbPath: params.kuzuDbPath,
        clonePath: params.clonePath,
        cmd,
        stderr: stderr.trim(),
        stdout: stdout.trim(),
      })
    }
    return exitCode
  }

  try {
    await mkdir(dirname(params.kuzuDbPath), { recursive: true })
    let exit = await runCgc(args)
    if (exit !== 0 && allowForceFallback) {
      exit = await runCgc(["cgc", "index", ".", "--force"])
    }
  } catch (error) {
    console.error("[codesearch] cgc index failed", {
      orgId: params.orgId,
      repoId: params.repoId,
      kuzuDbPath: params.kuzuDbPath,
      clonePath: params.clonePath,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function markCheckoutZoektIndexed(
  db: Db,
  repositoryId: string,
  commitSha: string | null,
): Promise<void> {
  await db
    .update(repositoryCheckouts)
    .set({
      commitSha,
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
): Promise<IndexRepoResult> {
  await ensureRepositoryClone({
    repoGitUrl: input.repoGitUrl,
    clonePath: input.clonePath,
    githubToken: input.githubToken,
  })

  const resolvedTarget = await resolveTargetCommitHash({
    repoGitUrl: input.repoGitUrl,
    clonePath: input.clonePath,
    githubToken: input.githubToken,
    targetHash: input.targetHash,
  })

  let ingestMode: "full" | "partial" = "full"
  let changedPaths: string[] = []
  let deletedPaths: string[] = []
  let renames: { from: string; to: string }[] = []

  if (input.fromHash && input.fromHash.trim().length > 0) {
    const fromResolved = await ensureCommitInRepo(
      input.clonePath,
      input.fromHash.trim(),
    )
    const ancestor = await isAncestor(
      input.clonePath,
      fromResolved,
      resolvedTarget,
    )
    ingestMode = ancestor ? "partial" : "full"
    if (ancestor) {
      const raw = await diffRangeNameStatus({
        clonePath: input.clonePath,
        fromSha: fromResolved,
        toSha: resolvedTarget,
      })
      const parsed = parseNameStatus(raw)
      changedPaths = parsed.changedPaths
      deletedPaths = parsed.deletedPaths
      renames = parsed.renames
    }
  }

  ensureCgcWatchBeforeCheckout({
    kuzuDbPath: input.kuzuDbPath,
    clonePath: input.clonePath,
  })

  await checkoutCommit(input.clonePath, resolvedTarget)

  await indexRepository({
    clonePath: input.clonePath,
    zoektRepoId: input.zoektRepoId,
    repoName: input.repoName,
    repoUrl: input.repoUrl,
  })
  const head = await readGitHead(input.clonePath)
  await markCheckoutZoektIndexed(input.db, input.repoId, head)
  await runCgcIndexQuietly({
    clonePath: input.clonePath,
    kuzuDbPath: input.kuzuDbPath,
    orgId: input.orgId,
    repoId: input.repoId,
    ingestMode,
  })

  return {
    targetHash: resolvedTarget,
    ingestMode,
    changedPaths,
    deletedPaths,
    renames,
  }
}
