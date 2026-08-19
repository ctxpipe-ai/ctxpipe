import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { and, eq } from "drizzle-orm"
import { ZOEKT_INDEX_DIR } from "../../config/paths.js"
import type { Db } from "../../db/client.js"
import { repositoryCheckouts } from "../../db/schema.js"
import { tryEmitIndexEvent } from "../../observability/indexingLog.js"
import { authenticatedGitUrl } from "../../utils/git.js"
import {
  decodeScipIndex,
  encodeScipIndex,
  mergeScipIndexes,
} from "../graph/scipProto.js"
import type { IndexingStepKey } from "../indexingSteps.js"
import { trySetRepositoryIndexingStep } from "../indexingSteps.js"
import {
  DEFAULT_CHECKOUT_KEY,
  scipLangShardPath,
} from "../repositories/paths.js"
import { resolveRepositoryRef } from "../repositories/resolveRef.js"
import { refreshPinnedRepo } from "../zoekt/pinManager.js"
import { detectLanguages, type ScipIndexerId } from "./detectLanguages.js"
import { withIndexerGoLimits } from "./indexerChildEnv.js"
import { withIndexerProcessSlot } from "./indexerProcessSemaphore.js"
import { errorFromIndexerExit } from "./memoryFitError.js"
import { runScipIndexer } from "./scipIndexers.js"
import { selectTouchedScipIndexers } from "./scipTouchedLanguages.js"
import { INDEX_CHILD_LOG_TAIL_BYTES, readStreamTail } from "./streamTail.js"

export type IndexPhaseRepoContext = {
  db: Db
  orgId: string
  repoId: string
  repoGitUrl: string
  clonePath: string
  scipIndexPath: string
  zoektRepoId: number
  zoektName: string
  repoName: string
  repoUrl: string
  githubToken?: string
}

export type CloneCheckoutResult = {
  targetHash: string
  ingestMode: "full" | "partial"
  changedPaths: string[]
  deletedPaths: string[]
  renames: { from: string; to: string }[]
}

export type DetectLanguagesResult = {
  detectedLanguages: string[]
  languagesToIndex: string[]
}

type WriteStep = (
  key: IndexingStepKey,
  scipLanguages?: string[],
) => Promise<void>

async function withPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const startMs = Date.now()
  tryEmitIndexEvent("codesearch.index.phase.start", { phase })
  try {
    const result = await fn()
    tryEmitIndexEvent("codesearch.index.phase.end", {
      phase,
      durationMs: Date.now() - startMs,
    })
    return result
  } catch (error) {
    tryEmitIndexEvent("codesearch.index.phase.end", {
      phase,
      durationMs: Date.now() - startMs,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
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
    outputTailBytes?: number
    heartbeat?: { indexerId: string }
  },
): Promise<void> {
  const subprocess = Bun.spawn(cmd, {
    cwd: options?.cwd,
    env: options?.env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const heartbeatOpt = options?.heartbeat
  const startMs = Date.now()
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  if (heartbeatOpt) {
    const pid = subprocess.pid
    heartbeatTimer = setInterval(() => {
      tryEmitIndexEvent("codesearch.index.phase.heartbeat", {
        indexerId: heartbeatOpt.indexerId,
        elapsedMs: Date.now() - startMs,
        pid,
      })
    }, 30_000)
  }

  const tailBytes = options?.outputTailBytes
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      tailBytes != null
        ? readStreamTail(subprocess.stdout, tailBytes)
        : new Response(subprocess.stdout).text(),
      tailBytes != null
        ? readStreamTail(subprocess.stderr, tailBytes)
        : new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
    if (exitCode !== 0) {
      if (exitCode === 137) {
        tryEmitIndexEvent("codesearch.index.memory_exceeded", {
          cmd: cmd[0],
          exitCode,
        })
      }
      throw errorFromIndexerExit({
        exitCode,
        stderr,
        stdout,
        headline: `Command failed with exit code ${exitCode}`,
      })
    }
  } finally {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
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
  await runCommand(["git", "clone", "--depth", "1", authUrl, params.clonePath])
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

async function ensureMergeBaseAvailable(
  clonePath: string,
  fromSha: string,
  toSha: string,
): Promise<void> {
  const maxIterations = 24
  for (let i = 0; i < maxIterations; i++) {
    const subprocess = Bun.spawn(["git", "merge-base", fromSha, toSha], {
      cwd: clonePath,
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await subprocess.exited
    if (exitCode === 0) return
    try {
      await runCommand(["git", "fetch", "origin", "--deepen", "256"], {
        cwd: clonePath,
      })
    } catch {
      // continue deepening / unshallow
    }
  }
  try {
    await runCommand(["git", "fetch", "origin", "--unshallow"], {
      cwd: clonePath,
    })
  } catch {
    // best-effort: some repos are not shallow
  }
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
  zoektName: string
  repoUrl: string
}): Promise<void> {
  await mkdir(ZOEKT_INDEX_DIR, { recursive: true })
  const metaPath = `/tmp/zoekt-meta-${randomUUID()}.json`
  const metadata = {
    ID: params.zoektRepoId,
    Name: params.zoektName,
    URL: params.repoUrl,
    Source: params.clonePath,
  }
  await writeFile(metaPath, JSON.stringify(metadata))
  try {
    await withIndexerProcessSlot(() =>
      runCommand(
        [
          "zoekt-index",
          "-index",
          ZOEKT_INDEX_DIR,
          "-parallelism",
          "1",
          "-meta",
          metaPath,
          params.clonePath,
        ],
        {
          outputTailBytes: INDEX_CHILD_LOG_TAIL_BYTES,
          env: withIndexerGoLimits(),
          heartbeat: { indexerId: "zoekt" },
        },
      ),
    )
  } finally {
    await rm(metaPath, { force: true })
  }
  await refreshPinnedRepo({
    zoektRepoId: params.zoektRepoId,
    zoektName: params.zoektName,
  })
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

export async function selectValidScipShardPaths(
  shardPaths: readonly string[],
): Promise<string[]> {
  const valid: string[] = []
  for (const shardPath of shardPaths) {
    let bytes: Buffer
    try {
      const info = await stat(shardPath)
      if (!info.isFile() || info.size === 0) {
        tryEmitIndexEvent("codesearch.index.scip.shard_skipped", {
          shardPath,
          reason: "empty",
        })
        continue
      }
      bytes = await readFile(shardPath)
    } catch {
      tryEmitIndexEvent("codesearch.index.scip.shard_skipped", {
        shardPath,
        reason: "missing",
      })
      continue
    }
    try {
      decodeScipIndex(bytes)
    } catch (error) {
      tryEmitIndexEvent("codesearch.index.scip.shard_skipped", {
        shardPath,
        reason: "malformed",
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    valid.push(shardPath)
  }
  return valid
}

/**
 * Publish a merged SCIP index from surviving shards.
 * No detected languages → empty index (success). Languages detected but no
 * valid shards → omit/delete the published file so graph tools soft-miss.
 */
export async function publishMergedScipIndex(input: {
  detectedLanguages: readonly string[]
  shardPaths: readonly string[]
  outputPath: string
}): Promise<{ shardCount: number }> {
  const valid = await selectValidScipShardPaths(input.shardPaths)
  if (valid.length === 0) {
    if (input.detectedLanguages.length === 0) {
      await writeMergedScipIndex([], input.outputPath)
    } else {
      await rm(input.outputPath, { force: true })
    }
    return { shardCount: 0 }
  }
  await writeMergedScipIndex(valid, input.outputPath)
  return { shardCount: valid.length }
}

export async function writeMergedScipIndex(
  shardPaths: readonly string[],
  outputPath: string,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`
  try {
    if (shardPaths.length === 0) {
      await writeFile(
        temporaryPath,
        encodeScipIndex({ documents: [], externalSymbols: [] }),
      )
    } else {
      const shards = await Promise.all(
        shardPaths.map(async (shardPath) => {
          const bytes = await readFile(shardPath)
          let index: ReturnType<typeof decodeScipIndex>
          try {
            index = decodeScipIndex(bytes)
          } catch (error) {
            throw new Error(
              `Malformed SCIP shard ${shardPath}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            )
          }
          if (bytes.byteLength === 0) {
            throw new Error(`Empty SCIP shard: ${shardPath}`)
          }
          return { bytes, index }
        }),
      )
      const singleShard = shards[0]
      await writeFile(
        temporaryPath,
        shards.length === 1 && singleShard
          ? singleShard.bytes
          : mergeScipIndexes(shards.map(({ index }) => index)),
      )
    }
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function monotonicWriteStep(db: Db, repoId: string): WriteStep {
  return (key, scipLanguages) =>
    trySetRepositoryIndexingStep(db, repoId, key, scipLanguages, {
      monotonic: true,
    })
}

export async function phaseCloneCheckout(
  ctx: IndexPhaseRepoContext,
  params: { targetHash?: string; fromHash?: string },
): Promise<CloneCheckoutResult> {
  const writeStep = monotonicWriteStep(ctx.db, ctx.repoId)

  await writeStep("cloning")
  await withPhase("clone", () =>
    ensureRepositoryClone({
      repoGitUrl: ctx.repoGitUrl,
      clonePath: ctx.clonePath,
      githubToken: ctx.githubToken,
    }),
  )

  await writeStep("checking_out")
  const resolvedTarget = await withPhase("resolve_commit", () =>
    resolveTargetCommitHash({
      repoGitUrl: ctx.repoGitUrl,
      clonePath: ctx.clonePath,
      githubToken: ctx.githubToken,
      targetHash: params.targetHash,
    }),
  )

  let ingestMode: "full" | "partial" = "full"
  let changedPaths: string[] = []
  let deletedPaths: string[] = []
  let renames: { from: string; to: string }[] = []

  if (params.fromHash && params.fromHash.trim().length > 0) {
    const fromHash = params.fromHash.trim()
    const diffResult = await withPhase("diff", async () => {
      const fromResolved = await ensureCommitInRepo(ctx.clonePath, fromHash)
      await ensureMergeBaseAvailable(
        ctx.clonePath,
        fromResolved,
        resolvedTarget,
      )
      const ancestor = await isAncestor(
        ctx.clonePath,
        fromResolved,
        resolvedTarget,
      )
      let mode: "full" | "partial" = "full"
      let changed: string[] = []
      let deleted: string[] = []
      let rns: { from: string; to: string }[] = []
      if (ancestor) {
        mode = "partial"
        const raw = await diffRangeNameStatus({
          clonePath: ctx.clonePath,
          fromSha: fromResolved,
          toSha: resolvedTarget,
        })
        const parsed = parseNameStatus(raw)
        changed = parsed.changedPaths
        deleted = parsed.deletedPaths
        rns = parsed.renames
      }
      return {
        ingestMode: mode,
        changedPaths: changed,
        deletedPaths: deleted,
        renames: rns,
      }
    })
    ingestMode = diffResult.ingestMode
    changedPaths = diffResult.changedPaths
    deletedPaths = diffResult.deletedPaths
    renames = diffResult.renames
  }

  await withPhase("checkout", () =>
    checkoutCommit(ctx.clonePath, resolvedTarget),
  )

  return {
    targetHash: resolvedTarget,
    ingestMode,
    changedPaths,
    deletedPaths,
    renames,
  }
}

export async function phaseZoekt(ctx: IndexPhaseRepoContext): Promise<void> {
  const writeStep = monotonicWriteStep(ctx.db, ctx.repoId)
  await writeStep("indexing_search")
  await withPhase("zoekt", () =>
    indexRepository({
      clonePath: ctx.clonePath,
      zoektRepoId: ctx.zoektRepoId,
      zoektName: ctx.zoektName,
      repoUrl: ctx.repoUrl,
    }),
  )
}

export async function phaseDetectLanguages(
  ctx: IndexPhaseRepoContext,
  params: {
    ingestMode: "full" | "partial"
    changedPaths: readonly string[]
    deletedPaths: readonly string[]
    renames: readonly { from: string; to: string }[]
  },
): Promise<DetectLanguagesResult> {
  const writeStep = monotonicWriteStep(ctx.db, ctx.repoId)
  await writeStep("detecting_languages")

  return withPhase("detect_languages", async () => {
    const detected = detectLanguages(ctx.clonePath) as string[]
    let languagesToIndex: string[] =
      params.ingestMode === "full"
        ? detected
        : selectTouchedScipIndexers(detected as ScipIndexerId[], [
            ...params.changedPaths,
            ...params.deletedPaths,
            ...params.renames.flatMap(({ from, to }) => [from, to]),
          ])

    if (params.ingestMode === "partial") {
      const selected = new Set(languagesToIndex)
      for (const indexerId of detected) {
        const shardPath = scipLangShardPath(ctx.orgId, ctx.repoId, indexerId)
        if (await pathExists(shardPath)) continue
        selected.add(indexerId)
      }
      languagesToIndex = detected.filter((indexerId) => selected.has(indexerId))
    }

    // Advance total so UI knows how many scip:* slots exist.
    await writeStep("detecting_languages", detected)

    return {
      detectedLanguages: detected,
      languagesToIndex,
    }
  })
}

export async function phaseScipLanguage(
  ctx: IndexPhaseRepoContext,
  params: {
    language: string
    detectedLanguages: readonly string[]
  },
): Promise<void> {
  const writeStep = monotonicWriteStep(ctx.db, ctx.repoId)
  const shardPath = scipLangShardPath(ctx.orgId, ctx.repoId, params.language)
  await withPhase(`scip:${params.language}`, async () => {
    await runScipIndexer({
      indexerId: params.language as ScipIndexerId,
      checkoutPath: ctx.clonePath,
      shardPath,
    })
  })
  await writeStep(`scip:${params.language}` as IndexingStepKey, [
    ...params.detectedLanguages,
  ])
}

export async function phaseMergeScip(
  ctx: IndexPhaseRepoContext,
  params: { detectedLanguages: readonly string[] },
): Promise<void> {
  const writeStep = monotonicWriteStep(ctx.db, ctx.repoId)
  const detected = [...params.detectedLanguages]
  await writeStep("merging_intelligence", detected)
  await withPhase("scip_merge", () =>
    publishMergedScipIndex({
      detectedLanguages: detected,
      shardPaths: detected.map((indexerId) =>
        scipLangShardPath(ctx.orgId, ctx.repoId, indexerId),
      ),
      outputPath: ctx.scipIndexPath,
    }),
  )
}

export async function phaseMarkCheckoutIndexed(
  ctx: IndexPhaseRepoContext,
): Promise<void> {
  const head = await readGitHead(ctx.clonePath)
  await ctx.db
    .update(repositoryCheckouts)
    .set({
      commitSha: head,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(repositoryCheckouts.repositoryId, ctx.repoId),
        eq(repositoryCheckouts.checkoutKey, DEFAULT_CHECKOUT_KEY),
      ),
    )
}
