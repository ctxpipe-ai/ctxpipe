import { randomUUID } from "node:crypto"
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tryEmitIndexEvent } from "../../observability/indexingLog.js"
import type { ScipIndexerId } from "./detectLanguages.js"
import { withIndexerGoLimits } from "./indexerChildEnv.js"
import { withIndexerProcessSlot } from "./indexerProcessSemaphore.js"
import { errorFromIndexerExit } from "./memoryFitError.js"
import { INDEX_CHILD_LOG_TAIL_BYTES, readStreamTail } from "./streamTail.js"

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
}): Promise<void> {
  await withIndexerProcessSlot(async () => {
    const subprocess = (() => {
      try {
        return Bun.spawn(input.argv, {
          cwd: input.checkoutPath,
          env: withIndexerGoLimits(input.env),
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
  })
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
 * serializes indexers that can only write `index.scip`.
 */
export async function runScipIndexer(input: {
  indexerId: ScipIndexerId
  checkoutPath: string
  shardPath: string
  env?: Record<string, string | undefined>
}): Promise<void> {
  const shardPath = resolve(input.shardPath)
  const outputFlag = SCIP_INDEXER_OUTPUT_FLAG[input.indexerId]
  await mkdir(dirname(shardPath), { recursive: true })

  if (outputFlag) {
    const argv = [...SCIP_INDEXER_ARGV[input.indexerId], outputFlag, shardPath]
    await rm(shardPath, { force: true })
    try {
      await runIndexerProcess({ ...input, argv })
      await verifyShard(input.indexerId, shardPath)
    } catch (error) {
      await removeFileBestEffort(shardPath)
      throw error
    }
    return
  }

  await withCheckoutMutex(input.checkoutPath, async () => {
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
}
