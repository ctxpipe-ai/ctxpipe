import { randomUUID } from "node:crypto"
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api"
import { tryEmitIndexEvent } from "../../observability/indexingLog.js"
import { mergeScipShardFiles } from "../graph/scipProto.js"
import { getIndexerProcessConcurrency } from "./capacityEnv.js"
import type { ScipIndexerId } from "./detectLanguages.js"
import { withIndexerGoLimits } from "./indexerChildEnv.js"
import { withIndexerProcessSlot } from "./indexerProcessSemaphore.js"
import { errorFromIndexerExit } from "./memoryFitError.js"
import { INDEX_CHILD_LOG_TAIL_BYTES, readStreamTail } from "./streamTail.js"
import {
  prepareTypeScriptWorkspace,
  scanTypeScriptWorkspace,
} from "./typeScriptProjects.js"

/**
 * Direct upstream SCIP indexer CLIs. These commands run from the checkout root.
 *
 * - Go, TypeScript, Python, Java, Clang, Ruby, and .NET are the scip-code /
 *   Sourcegraph indexers.
 * - Rust uses rust-analyzer's built-in `scip` command.
 * - Dart, PHP, and Debian use the executables published by scip-dart,
 *   scip-php, and debian-lsp respectively.
 *
 * scip-clang has no `index` subcommand and requires a compilation database.
 * rust-analyzer and debian-lsp require an explicit source-root argument.
 */
export const SCIP_INDEXER_ARGV: Readonly<
  Record<ScipIndexerId, readonly string[]>
> = {
  go: ["scip-go"],
  typescript: ["scip-typescript", "index"],
  python: ["scip-python", "index", "."],
  java: ["scip-java", "index"],
  rust: ["rust-analyzer", "scip", "."],
  clang: ["scip-clang", "--compdb-path=compile_commands.json"],
  ruby: ["scip-ruby"],
  dotnet: ["scip-dotnet", "index"],
  dart: ["scip_dart"],
  php: ["scip-php"],
  debian: ["debian-lsp", "scip", "."],
}

export const SCIP_INDEXER_OUTPUT_FLAG: Readonly<
  Record<ScipIndexerId, string | null>
> = {
  go: "--output",
  typescript: "--output",
  python: "--output",
  java: "--output",
  rust: "--output",
  clang: "--index-output-path",
  ruby: "--index-file",
  dotnet: "--output",
  dart: "--output",
  php: null,
  debian: "-o",
}

const checkoutMutexes = new Map<string, Promise<void>>()

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  )
}

async function removeFileBestEffort(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

async function moveIndexerOutput(
  generatedPath: string,
  shardPath: string,
): Promise<void> {
  await mkdir(dirname(shardPath), { recursive: true })
  try {
    await rename(generatedPath, shardPath)
  } catch (error) {
    if (!isErrorWithCode(error, "EXDEV")) throw error
    await copyFile(generatedPath, shardPath)
    await rm(generatedPath)
  }
}

async function withCheckoutMutex<Result>(
  checkoutPath: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const key = resolve(checkoutPath)
  const previous = checkoutMutexes.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent
  })
  const tail = previous.then(() => current)
  checkoutMutexes.set(key, tail)

  await previous
  try {
    return await operation()
  } finally {
    release()
    if (checkoutMutexes.get(key) === tail) {
      checkoutMutexes.delete(key)
    }
  }
}

async function runIndexerProcess(input: {
  indexerId: ScipIndexerId
  checkoutPath: string
  argv: string[]
  env?: Record<string, string | undefined>
  /** Node heap for Node-based indexers; set after the env allowlist. */
  heapMb?: number
}): Promise<void> {
  await withIndexerProcessSlot(() =>
    trace
      .getTracer("codesearch")
      .startActiveSpan(
        "scip.indexer.process",
        { attributes: { "scip.indexer": input.indexerId } },
        async (span) => {
          try {
            await runIndexerSubprocess(input, span)
          } catch (error) {
            const message = errorMessage(error)
            span.recordException(error instanceof Error ? error : message)
            span.setStatus({ code: SpanStatusCode.ERROR, message })
            throw error
          } finally {
            span.end()
          }
        },
      ),
  )
}

async function runIndexerSubprocess(
  input: Parameters<typeof runIndexerProcess>[0],
  span: Span,
): Promise<void> {
  const subprocess = (() => {
    try {
      return Bun.spawn(input.argv, {
        cwd: input.checkoutPath,
        env: {
          ...withIndexerGoLimits(input.env),
          ...(input.heapMb
            ? { NODE_OPTIONS: `--max-old-space-size=${input.heapMb}` }
            : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
    } catch (error) {
      throw new Error(
        `SCIP indexer "${input.indexerId}" failed to start (${input.argv.join(" ")}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
  })()

  const startMs = Date.now()
  const pid = subprocess.pid
  const heartbeatTimer = setInterval(() => {
    tryEmitIndexEvent("codesearch.index.phase.heartbeat", {
      indexerId: input.indexerId,
      elapsedMs: Date.now() - startMs,
      pid,
    })
  }, 30_000)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readStreamTail(subprocess.stdout, INDEX_CHILD_LOG_TAIL_BYTES),
      readStreamTail(subprocess.stderr, INDEX_CHILD_LOG_TAIL_BYTES),
      subprocess.exited,
    ])
    span.setAttribute("process.exit.code", exitCode)
    // Record the peak memory and the CPU time of the indexer for the
    // ingestion profile. Bun gives no usage before the process exits, and it
    // gives the CPU time as a bigint, but its type is number.
    const usage = subprocess.resourceUsage()
    if (usage)
      span.setAttributes({
        "scip.process.max_rss_mb": Math.round(usage.maxRSS / 1024 / 1024),
        "scip.process.cpu_ms": Math.round(Number(usage.cpuTime.total) / 1000),
      })

    if (exitCode !== 0) {
      if (exitCode === 137) {
        tryEmitIndexEvent("codesearch.index.memory_exceeded", {
          indexerId: input.indexerId,
          exitCode,
        })
      }
      throw errorFromIndexerExit({
        exitCode,
        stderr,
        stdout,
        headline: `SCIP indexer "${input.indexerId}" failed with exit code ${exitCode} (${input.argv.join(" ")})`,
      })
    }
  } finally {
    clearInterval(heartbeatTimer)
  }
}

async function verifyShard(
  indexerId: ScipIndexerId,
  shardPath: string,
): Promise<void> {
  let shardStat: Awaited<ReturnType<typeof stat>>
  try {
    shardStat = await stat(shardPath)
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      throw new Error(
        `SCIP indexer "${indexerId}" exited successfully but did not produce ${shardPath}`,
        { cause: error },
      )
    }
    throw error
  }

  if (!shardStat.isFile()) {
    throw new Error(
      `SCIP indexer "${indexerId}" produced ${shardPath}, but it is not a regular file`,
    )
  }
  if (shardStat.size === 0) {
    throw new Error(
      `SCIP indexer "${indexerId}" produced an empty shard at ${shardPath}`,
    )
  }
}

/**
 * Run one SCIP indexer fail-closed and write its index to the requested shard.
 * Indexers with output flags write there directly. A checkout-scoped mutex
 * serializes indexers that can only write `index.scip`. TypeScript returns
 * an `issue` when only some of its projects could be indexed.
 */
export async function runScipIndexer(input: {
  indexerId: ScipIndexerId
  checkoutPath: string
  shardPath: string
  env?: Record<string, string | undefined>
}): Promise<{ issue?: string }> {
  const shardPath = resolve(input.shardPath)
  const outputFlag = SCIP_INDEXER_OUTPUT_FLAG[input.indexerId]

  // Join the checkout queue before any await, so runs on one checkout start
  // in the order they were requested.
  if (input.indexerId === "typescript") {
    return withCheckoutMutex(input.checkoutPath, async () => {
      await mkdir(dirname(shardPath), { recursive: true })
      return runTypeScriptIndexer({ ...input, shardPath })
    })
  }

  if (outputFlag) {
    await mkdir(dirname(shardPath), { recursive: true })
    const argv = [...SCIP_INDEXER_ARGV[input.indexerId], outputFlag, shardPath]
    await rm(shardPath, { force: true })
    try {
      await runIndexerProcess({ ...input, argv })
      await verifyShard(input.indexerId, shardPath)
    } catch (error) {
      await removeFileBestEffort(shardPath)
      throw error
    }
    return {}
  }

  await withCheckoutMutex(input.checkoutPath, async () => {
    await mkdir(dirname(shardPath), { recursive: true })
    const generatedPath = join(resolve(input.checkoutPath), "index.scip")
    const temporaryPath = join(
      dirname(shardPath),
      `.${basename(shardPath)}.${randomUUID()}.tmp`,
    )
    await rm(generatedPath, { force: true })
    await rm(shardPath, { force: true })

    try {
      await runIndexerProcess({
        ...input,
        argv: [...SCIP_INDEXER_ARGV[input.indexerId]],
      })
      await moveIndexerOutput(generatedPath, temporaryPath)
      await rename(temporaryPath, shardPath)
      await verifyShard(input.indexerId, shardPath)
    } catch (error) {
      await Promise.all([
        removeFileBestEffort(generatedPath),
        removeFileBestEffort(temporaryPath),
        removeFileBestEffort(shardPath),
      ])
      if (isErrorWithCode(error, "ENOENT")) {
        throw new Error(
          `SCIP indexer "${input.indexerId}" exited successfully but did not produce ${generatedPath}`,
          { cause: error },
        )
      }
      throw error
    }
  })
  return {}
}

type ProjectOutcome =
  | { status: "indexed"; shard: string }
  | { status: "empty" }
  | { status: "failed"; error: unknown }

/**
 * Index every TypeScript project in its own process, so one project's heap or
 * config failure cannot sink the rest, then merge the per-project shards.
 *
 * - Projects without inputs are skipped.
 * - Some projects failing yields an `issue` for the repository status.
 * - All failing throws, except in a repository that only has nested configs
 *   and no workspace (e.g. a docs site inside a Go repo): there TypeScript is
 *   incidental, so the run soft-skips with an empty shard.
 */
async function runTypeScriptIndexer(input: {
  checkoutPath: string
  shardPath: string
  env?: Record<string, string | undefined>
}): Promise<{ issue?: string }> {
  const workspace = await scanTypeScriptWorkspace(input.checkoutPath)
  const { configPaths, standaloneConfig, cleanup } =
    await prepareTypeScriptWorkspace(input.checkoutPath, workspace)
  // V8's default heap follows host memory (2 GB in an 8 GB container), which
  // a large monorepo package outgrows; give each concurrent indexer 3/4 of
  // its share of the container.
  const shareMb =
    process.constrainedMemory() / 1024 / 1024 / getIndexerProcessConcurrency()
  const heapMb = Math.min(8192, Math.floor(shareMb * 0.75)) || 4096
  const outcomes: Array<{ dir: string; outcome: ProjectOutcome }> = []
  await rm(input.shardPath, { force: true })
  try {
    for (const project of workspace.projects) {
      const configPath = configPaths.get(project.dir) as string
      let outcome = await indexTypeScriptProject({
        ...input,
        configPath,
        heapMb,
      })
      // A config error (usually an `extends` base only an install provides):
      // retry once with the project's own config without `extends`.
      if (outcome.status === "failed" && hasConfigDiagnostics(outcome.error)) {
        const retry = await indexTypeScriptProject({
          ...input,
          configPath: await standaloneConfig(project.dir),
          heapMb,
        })
        if (retry.status !== "failed") {
          tryEmitIndexEvent(
            "codesearch.index.scip.typescript_extends_dropped",
            {
              project: project.dir || ".",
              error: errorMessage(outcome.error),
            },
          )
          outcome = retry
        }
      }
      if (outcome.status === "failed") {
        tryEmitIndexEvent("codesearch.index.scip.typescript_project_failed", {
          project: project.dir || ".",
          error: errorMessage(outcome.error),
        })
      }
      outcomes.push({ dir: project.dir, outcome })
    }
    const shards = outcomes.flatMap(({ outcome }) =>
      outcome.status === "indexed" ? [outcome.shard] : [],
    )
    const failed = outcomes.flatMap(({ dir, outcome }) =>
      outcome.status === "failed" ? [{ dir, error: outcome.error }] : [],
    )
    const incidental =
      !workspace.monorepo &&
      !workspace.projects.some((project) => project.dir === "")
    tryEmitIndexEvent("codesearch.index.scip.typescript_projects", {
      projects: workspace.projects.length,
      indexed: shards.length,
      empty: outcomes.length - shards.length - failed.length,
      failed: failed.length,
      failedProjects: failed.map(({ dir }) => dir || "."),
      linkedPackages: workspace.packages.length,
      heapMb,
    })

    if (shards.length === 0 && failed.length > 0 && !incidental) {
      throw failed[0]?.error
    }
    if (shards.length === 0) {
      if (failed.length > 0) {
        tryEmitIndexEvent("codesearch.index.scip.typescript_soft_skipped", {
          failedProjects: failed.map(({ dir }) => dir || "."),
        })
      }
      // An Index holding only empty metadata: valid, and not a 0-byte file.
      await writeFile(input.shardPath, new Uint8Array([0x0a, 0x00]))
      return {}
    }
    const [onlyShard] = shards
    if (shards.length === 1 && onlyShard) {
      await rename(onlyShard, input.shardPath)
    } else {
      await mergeScipShardFiles(shards, input.shardPath, { dedupe: true })
    }
    await verifyShard("typescript", input.shardPath)
    if (failed.length === 0) return {}
    const names = failed.slice(0, 3).map(({ dir }) => dir || ".")
    const more = failed.length > 3 ? ` and ${failed.length - 3} more` : ""
    return {
      issue: `TypeScript code intelligence is incomplete: ${failed.length} of ${workspace.projects.length} projects could not be indexed (${names.join(", ")}${more})`,
    }
  } catch (error) {
    await removeFileBestEffort(input.shardPath)
    throw error
  } finally {
    await Promise.all(
      outcomes.flatMap(({ outcome }) =>
        outcome.status === "indexed"
          ? [removeFileBestEffort(outcome.shard)]
          : [],
      ),
    )
    await cleanup()
  }
}

async function indexTypeScriptProject(input: {
  checkoutPath: string
  shardPath: string
  env?: Record<string, string | undefined>
  configPath: string
  heapMb: number
}): Promise<ProjectOutcome> {
  const project = relative(input.checkoutPath, dirname(input.configPath)) || "."
  const shard = join(
    dirname(input.shardPath),
    `.${basename(input.shardPath)}.${randomUUID()}.tmp`,
  )
  return trace
    .getTracer("codesearch")
    .startActiveSpan(
      "scip.typescript.project",
      { attributes: { "scip.project": project, "scip.heap_mb": input.heapMb } },
      async (span): Promise<ProjectOutcome> => {
        try {
          await runIndexerProcess({
            indexerId: "typescript",
            checkoutPath: input.checkoutPath,
            env: input.env,
            heapMb: input.heapMb,
            argv: [
              ...SCIP_INDEXER_ARGV.typescript,
              "--output",
              shard,
              input.configPath,
            ],
          })
          await verifyShard("typescript", shard)
          span.setAttribute("scip.outcome", "indexed")
          return { status: "indexed", shard }
        } catch (error) {
          await removeFileBestEffort(shard)
          const message = errorMessage(error)
          // Nothing to index, as opposed to a config that failed to load
          // (which also ends in "no files got indexed", after diagnostics).
          if (
            /no files got indexed|no indexable files in project/.test(
              message,
            ) &&
            !hasConfigDiagnostics(error)
          ) {
            span.setAttribute("scip.outcome", "empty")
            return { status: "empty" }
          }
          span.setAttribute("scip.outcome", "failed")
          span.recordException(error instanceof Error ? error : message)
          span.setStatus({ code: SpanStatusCode.ERROR, message })
          return { status: "failed", error }
        } finally {
          span.end()
        }
      },
    )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** TypeScript config diagnostics (`error TS6053: File '…' not found`, …). */
function hasConfigDiagnostics(error: unknown): boolean {
  return /error TS\d+/.test(errorMessage(error))
}
