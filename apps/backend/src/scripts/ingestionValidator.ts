/**
 * End-to-end ingestion validator (PR 280 ticket 04). For each repository in a
 * list: enqueue a full re-ingest stamped with the validator run id as
 * `request.id`, follow the native OpenWorkflow run trees (its own run and any
 * tip-ahead follow-ups) and the hydrate to a terminal state, then check every
 * stage — codesearch (Zoekt + SCIP), the extraction commit and its knowledge
 * files, the hydrate projection at that commit (units, graph, embeddings),
 * size bounds and quality — and record timings, trace ids, LLM tokens, the
 * models used, and OpenRouter spend. Writes `validator-<run-id>.json` and
 * `.md` to `--out-dir`.
 *
 * Modes: `index-only` (default) needs an org with no Workspace, so ingestion
 * stops after codesearch and no LLM call can run. `--mode full` spends: it
 * links each repository to `--workspace-id`, which must be the org's only
 * Workspace. Both guards are re-checked before every repository. The
 * validator refuses production and, on Railway, the default OpenWorkflow
 * namespace.
 *
 * Usage (apps/backend; env of the target environment, e.g. inside
 * `railway ssh --environment <env> --service backend`):
 *   bun run src/scripts/ingestionValidator.ts --org-id <org> --repos repos.txt \
 *     [--mode full --workspace-id <ws>] [--concurrency 1] [--timeout-minutes 180] \
 *     [--poll-seconds 15] [--out-dir .] [--run-id val_…] [--quality-thresholds t.json] \
 *     [--hyperdx-url …] [--langfuse-url …]
 *
 * Repos file: one `owner/name` or git URL per line, optionally followed by the SCIP
 * languages that must be indexed (`n8n-io/n8n typescript,javascript`).
 * Langfuse totals need `LANGFUSE_AUTH_STRING` (ops/observability/USING.md).
 * Exits 1 unless every repository is PASS or WARN.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { otelDeploymentEnvironment } from "../observability/otel.js"
import { openWorkflowNamespaceId } from "../openworkflow/namespace.js"
import {
  parseReposFile,
  type QualityThresholds,
  qualityThresholdsSchema,
  type RepoSpec,
  type ValidatorMode,
  validatorModeSchema,
} from "./ingestionValidatorReport.js"

export type ValidatorOptions = {
  orgId: string
  workspaceId: string | null
  mode: ValidatorMode
  repos: RepoSpec[]
  concurrency: number
  timeoutMinutes: number
  pollSeconds: number
  outDir: string
  runId: string
  qualityThresholds: QualityThresholds | null
  hyperdxUrl: string
  langfuseUrl: string
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const next = index >= 0 ? argv[index + 1] : undefined
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

function positiveInt(argv: string[], name: string, fallback: number): number {
  const raw = flag(argv, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`)
  return value
}

export function parseOptions(argv: string[]): ValidatorOptions {
  const orgId = flag(argv, "--org-id")
  const reposFile = flag(argv, "--repos")
  if (!orgId || !reposFile) throw new Error("--org-id and --repos are required")
  const mode = validatorModeSchema.parse(flag(argv, "--mode") ?? "index-only")
  const workspaceId = flag(argv, "--workspace-id") ?? null
  if (mode === "full" && !workspaceId)
    throw new Error("--mode full needs --workspace-id")
  if (mode === "index-only" && workspaceId)
    throw new Error("--workspace-id is only for --mode full")
  const repos = parseReposFile(readFileSync(reposFile, "utf8"))
  if (repos.length === 0) throw new Error("the repos file lists no repository")
  const thresholdsFile = flag(argv, "--quality-thresholds")
  return {
    orgId,
    workspaceId,
    mode,
    repos,
    concurrency: positiveInt(argv, "--concurrency", 1),
    timeoutMinutes: positiveInt(argv, "--timeout-minutes", 180),
    pollSeconds: positiveInt(argv, "--poll-seconds", 15),
    outDir: resolve(flag(argv, "--out-dir") ?? "."),
    runId:
      flag(argv, "--run-id") ??
      `val_${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`,
    qualityThresholds: thresholdsFile
      ? qualityThresholdsSchema.parse(
          JSON.parse(readFileSync(thresholdsFile, "utf8")),
        )
      : null,
    hyperdxUrl: flag(argv, "--hyperdx-url") ?? "https://hyperdx.ctxpipe.ai",
    langfuseUrl: flag(argv, "--langfuse-url") ?? "https://langfuse.ctxpipe.ai",
  }
}

/** Why this process must not run the validator, if it must not. */
export function environmentProblem(
  env: Record<string, string | undefined>,
): string | null {
  const deployment = otelDeploymentEnvironment(
    env.RAILWAY_ENVIRONMENT_NAME,
    env.NODE_ENV,
    env.OTEL_RESOURCE_ATTRIBUTES,
  )
  if (deployment === "production")
    return "the validator refuses the production environment"
  if (
    env.RAILWAY_ENVIRONMENT_NAME?.trim() &&
    openWorkflowNamespaceId(env) === "default"
  )
    return "on Railway the validator needs its own OPENWORKFLOW_NAMESPACE_ID, not the default namespace"
  return null
}

/** Guards first, so a refused environment never connects to its database. */
export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const problem = environmentProblem(env)
  if (problem) throw new Error(problem)
  const options = parseOptions(argv)
  const { runValidator } = await import("./ingestionValidatorRun.js")
  return runValidator(options)
}

if (import.meta.main) {
  await import("../observability/load-dotenv.js")
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exit(1)
    })
}
