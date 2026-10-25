/**
 * Ingestion shadow comparison (CTX-584 T20, ADR-052). For each finished
 * ingestion v2 shadow run of an org, compares the old pipeline's extracted
 * files at its published commit with the changed files on the run's
 * assembled ref, and reports recall, rejects, cost, p95 time, and the phase 3
 * exit decision. The shadow refs stay 7 days after a run, so run this inside
 * that window.
 *
 * Usage (apps/backend):
 *   bun run src/scripts/ingestionCompare.ts --org-id <org>
 *     [--run-id <id> ...] [--since <ISO time>] [--revisions revisions.json]
 *     [--labels labels.json] [--costs costs.json] [--injection-fixtures]
 *     [--out report.json]
 *
 * `revisions.json`: an object from shadow run id to Workspace id to
 * `{ "oldPublished": <old run published SHA>, "shadowBase": <v2 pinned SHA> }`.
 * Stored write jobs and resolve steps supply these commits by default.
 * Manual values fill missing stored values only.
 * `labels.json`: an array of `IngestionLabelSet`. `costs.json`: an object
 * from shadow run id to `{ "old": <USD>, "shadow": <USD> }` (read the model
 * cost from Langfuse). `--injection-fixtures` scans for the T19 payloads.
 * The Markdown report goes to stdout; put it in the Linear document of T20.
 *
 * Env: apps/backend/.env.local (DATABASE_URL and the GitHub App settings).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"

import { parseEnv } from "../config/env.js"
import { closeDb, initDb } from "../db/client.js"
import {
  type ComparisonRevisions,
  compareShadowRun,
} from "../domain/ingestion/ingestion-compare-run.js"
import {
  buildComparisonReport,
  type IngestionLabelSet,
  type InjectionPayload,
  type RunComparison,
  renderComparisonMarkdown,
} from "../domain/ingestion/ingestion-compare.js"
import { INJECTION_CASES } from "../domain/ingestion/injection-fixtures.js"
import { resolveRepositoryReadCredential } from "../domain/workspaces/resolve-revision.js"
import { finishedShadowRunPairs } from "../models/ingestion-shadow-runs.js"
import { getWorkspaceWriteAdmission } from "../models/workspaces.js"
import { flushEvlog, initEvlog, log } from "../observability/logger.js"
import { gitRemoteEnvironment } from "../services/git/clone-tree.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local"), quiet: true })
initEvlog({ stderr: true })

function flags(argv: string[], name: string): string[] {
  return argv.flatMap((arg, i) => {
    const next = argv[i + 1]
    return arg === name && next !== undefined && !next.startsWith("--")
      ? [next]
      : []
  })
}

function readJson<T>(path: string | undefined): T | undefined {
  return path ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined
}

async function main(argv: string[]): Promise<void> {
  const [orgId] = flags(argv, "--org-id")
  if (!orgId) throw new Error("--org-id is required")
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  const env = parseEnv(process.env)
  const runIds = flags(argv, "--run-id")
  const [since] = flags(argv, "--since")
  const revisions = readJson<Record<string, ComparisonRevisions>>(
    flags(argv, "--revisions")[0],
  )
  const labels = readJson<IngestionLabelSet[]>(flags(argv, "--labels")[0])
  const costs =
    readJson<Record<string, { old: number | null; shadow: number | null }>>(
      flags(argv, "--costs")[0],
    ) ?? {}
  const payloads: InjectionPayload[] = argv.includes("--injection-fixtures")
    ? INJECTION_CASES.map((c) => ({ id: c.id, text: c.payload.text }))
    : []

  initDb(databaseUrl)
  try {
    const pairs = await finishedShadowRunPairs({
      orgId,
      ...(runIds.length ? { runIds } : {}),
      ...(since ? { since: new Date(since) } : {}),
    })
    const remoteFor = async (workspaceId: string) => {
      const admission = await getWorkspaceWriteAdmission(workspaceId, orgId)
      if (!admission)
        throw new Error(`The Workspace ${workspaceId} is not in the org`)
      const { remote } = admission.revision
      const token = await resolveRepositoryReadCredential({
        orgId,
        env,
        remote,
      })
      return {
        url: remote.url,
        env: gitRemoteEnvironment({ url: remote.url, token }),
      }
    }
    const runs: RunComparison[] = []
    for (const pair of pairs)
      runs.push(
        await compareShadowRun({
          pair,
          remoteFor,
          revisions: revisions?.[pair.shadowRunId],
          ...(labels ? { labels } : {}),
          injectionPayloads: payloads,
          ...(costs[pair.shadowRunId]
            ? { costUsd: costs[pair.shadowRunId] }
            : {}),
        }),
      )
    const report = buildComparisonReport(runs)
    const [out] = flags(argv, "--out")
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(renderComparisonMarkdown(report))
  } finally {
    await closeDb()
  }
}

main(process.argv.slice(2)).catch(async (error) => {
  log.error({
    step: "ingestion.compare",
    message: error instanceof Error ? error.message : String(error),
  })
  await flushEvlog()
  process.exitCode = 1
})
