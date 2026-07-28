import { copyFile, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { ScipIndexerId } from "./detectLanguages.js"
import { INDEX_CHILD_LOG_TAIL_BYTES, readStreamTail } from "./streamTail.js"

/**
 * Direct upstream SCIP indexer CLIs. These commands run from the checkout root
 * and write `index.scip` there by default.
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
  dart: ["scip-dart"],
  php: ["scip-php"],
  debian: ["debian-lsp", "scip", "."],
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  )
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

/**
 * Run one SCIP indexer fail-closed and move its generated index into the
 * requested shard path.
 */
export async function runScipIndexer(input: {
  indexerId: ScipIndexerId
  checkoutPath: string
  shardPath: string
  env?: Record<string, string | undefined>
}): Promise<void> {
  const argv = [...SCIP_INDEXER_ARGV[input.indexerId]]
  const generatedPath = join(input.checkoutPath, "index.scip")

  if (resolve(generatedPath) !== resolve(input.shardPath)) {
    await rm(generatedPath, { force: true })
  }

  const subprocess = (() => {
    try {
      return Bun.spawn(argv, {
        cwd: input.checkoutPath,
        env: input.env ? { ...process.env, ...input.env } : undefined,
        stdout: "pipe",
        stderr: "pipe",
      })
    } catch (error) {
      throw new Error(
        `SCIP indexer "${input.indexerId}" failed to start (${argv.join(" ")}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
  })()

  const [stdout, stderr, exitCode] = await Promise.all([
    readStreamTail(subprocess.stdout, INDEX_CHILD_LOG_TAIL_BYTES),
    readStreamTail(subprocess.stderr, INDEX_CHILD_LOG_TAIL_BYTES),
    subprocess.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(
      [
        `SCIP indexer "${input.indexerId}" failed with exit code ${exitCode} (${argv.join(" ")})`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : "",
        stdout.trim() ? `stdout: ${stdout.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  if (resolve(generatedPath) === resolve(input.shardPath)) return

  try {
    await moveIndexerOutput(generatedPath, input.shardPath)
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      throw new Error(
        `SCIP indexer "${input.indexerId}" exited successfully but did not produce ${generatedPath}`,
        { cause: error },
      )
    }
    throw new Error(
      `SCIP indexer "${input.indexerId}" could not move ${generatedPath} to ${input.shardPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}
