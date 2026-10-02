/**
 * Enqueue a full re-index for repositories of one organization (rollout tooling,
 * ADR-033): after deploying a graph change, enqueue this full re-ingest, then
 * read `graph-quality-report`. The run itself retracts unobserved evidence.
 *
 * Full means `fullReingest: true`: the workflow ignores the last ingested commit
 * (codesearch full mode) and, once extraction succeeds, sweeps evidence the run
 * did not re-observe — the same path as the "Reindex" button in the UI.
 *
 * `--deterministic-only` instead re-reads the repository with only the
 * deterministic extractors (decisions, CODEOWNERS, connector files, path
 * links): no LLM calls and no sweep. Use it to roll out an extractor change
 * that needs no LLM, e.g. decision scoping (ADR-036).
 *
 * Usage (apps/backend; DATABASE_URL and the OpenWorkflow / Railway wake variables
 * come from the environment, e.g. `railway run --environment <env> --service backend -- …`):
 *   bun run src/scripts/reindexRepositories.ts --org-id <org> --all [--reason "graph ontology v2"]
 *   bun run src/scripts/reindexRepositories.ts --org-id <org> --repository-id <id> [--repository-id <id> …]
 *   add --dry-run to list what would be enqueued, --deterministic-only to skip LLM extractors.
 */
import { resolve } from "node:path"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const next = index >= 0 ? argv[index + 1] : undefined
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

function flags(argv: string[], name: string): string[] {
  const out: string[] = []
  argv.forEach((arg, index) => {
    const next = argv[index + 1]
    if (arg === name && next && !next.startsWith("--")) out.push(next)
  })
  return out
}

async function main(argv: string[]): Promise<void> {
  const orgId = flag(argv, "--org-id")
  if (!orgId) throw new Error("--org-id is required")
  const all = argv.includes("--all")
  const requested = flags(argv, "--repository-id")
  if (!all && requested.length === 0) {
    throw new Error("pass --all or one or more --repository-id <id>")
  }
  const dryRun = argv.includes("--dry-run")
  const deterministicOnly = argv.includes("--deterministic-only")
  const reason = flag(argv, "--reason") ?? "graph re-index"
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")

  // Dynamic imports: the OpenWorkflow client reads DATABASE_URL at module load.
  const { closeDb, initDb } = await import("../db/client.js")
  initDb(connectionString)
  const { listRepositoriesForOrg } = await import("../models/repositories.js")
  const { enqueueRepositoryIngestionWorkflow } = await import(
    "../openworkflow/enqueue-repository-ingestion.js"
  )

  try {
    const repositories = await listRepositoriesForOrg(orgId)
    const selected = all
      ? repositories
      : repositories.filter((repository) => requested.includes(repository.id))
    const missing = requested.filter(
      (id) => !repositories.some((repository) => repository.id === id),
    )
    if (missing.length > 0) {
      throw new Error(
        `Unknown repository ids for this org: ${missing.join(", ")}`,
      )
    }
    const errors: string[] = []
    const log = {
      error: (error: Error) => {
        errors.push(error.message)
      },
    }
    for (const repository of selected) {
      if (dryRun) {
        process.stdout.write(
          `would enqueue ${repository.id} ${repository.name}\n`,
        )
        continue
      }
      await enqueueRepositoryIngestionWorkflow(
        {
          repositoryId: repository.id,
          orgId,
          indexingReason: reason,
          ...(deterministicOnly
            ? { deterministicOnly }
            : { fullReingest: true }),
        },
        log,
      )
      process.stdout.write(`enqueued ${repository.id} ${repository.name}\n`)
    }
    process.stdout.write(
      `${JSON.stringify({ orgId, selected: selected.length, dryRun, deterministicOnly, errors })}\n`,
    )
    if (errors.length > 0) process.exitCode = 1
  } finally {
    await closeDb()
  }
}

main(process.argv.slice(2))
  .then(async () => {
    // The worker wake after the last enqueue is fire-and-forget; give it a
    // moment, then exit — the workflow client otherwise keeps the process alive.
    await setTimeout(2_000)
    process.exit(process.exitCode ?? 0)
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  })
