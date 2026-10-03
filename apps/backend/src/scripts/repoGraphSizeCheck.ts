/**
 * Does an ingested repository have a graph the size of the repository?
 * Estimates lower bounds per node kind from a checkout's tracked paths
 * (packages, instruction and decision docs, TypeScript sources) and compares
 * them with the Workspace knowledge units the repository's latest extraction
 * wrote (ADR-046), and with documents in its SCIP index.
 * Exits 1 when any measured count is under its bound.
 *
 * Usage (apps/backend):
 *   bun run src/scripts/repoGraphSizeCheck.ts --checkout ../some-repo \
 *     [--org-id org_… --workspace-id ws_… --repository-id repo_…] [--scip /data/…/index.scip]
 *
 * Env: apps/backend/.env.local — DATABASE_URL (only with --repository-id).
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import {
  readExtractWriteJob,
  readRepositoryUnits,
  unitKinds,
} from "../models/repository-knowledge-units.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const next = index >= 0 ? argv[index + 1] : undefined
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

const NOT_A_PACKAGE =
  /(^|\/)(node_modules|dist|build|vendor|test|tests|__tests__|fixtures?|examples?|templates?)\//

/** Lower bounds per measured count, derived from the checkout's files. */
export function estimateRepoGraph(paths: string[]): {
  facts: Record<string, number>
  expected: Record<string, number>
} {
  const lower = paths.map((p) => p.toLowerCase())
  const manifests = paths.filter(
    (p) =>
      /(^|\/)(package\.json|go\.mod|Cargo\.toml|pyproject\.toml)$/.test(p) &&
      !NOT_A_PACKAGE.test(p),
  )
  const nested = manifests.filter((p) => p.includes("/"))
  const roots = Math.max(1, nested.length)
  const rootDirs = new Set(nested.map((p) => p.slice(0, p.lastIndexOf("/"))))
  const instructionFiles = lower.filter(
    (p) =>
      /(^|\/)(agents|claude|contributing)\.md$/.test(p) ||
      /(^|\/)\.(cursor|agents)\/rules\//.test(p) ||
      /(^|\/)skill\.md$/.test(p) ||
      p === "readme.md" ||
      (p.endsWith("/readme.md") &&
        rootDirs.has(p.slice(0, -"/readme.md".length))),
  ).length
  const decisionFiles = lower.filter((p) =>
    /(^|\/)(adr|adrs|decisions)\/.+\.mdx?$/.test(p),
  ).length
  const typeScriptSources = lower.filter(
    (p) =>
      /\.(ts|tsx|mts|cts)$/.test(p) &&
      !p.endsWith(".d.ts") &&
      !NOT_A_PACKAGE.test(p),
  ).length

  // Deliberately loose floors: most packages classify as a Service, App or
  // Library; about half the instruction files state at least one norm; most
  // decision records parse; package tsconfigs often exclude tests, so a SCIP
  // index covers well over 60% of TypeScript sources.
  const packageNodes = Math.floor(roots * 0.8)
  const instructionUnits = Math.floor(instructionFiles * 0.5)
  const decisions = Math.floor(decisionFiles * 0.8)
  return {
    facts: {
      trackedFiles: paths.length,
      roots,
      instructionFiles,
      decisionFiles,
      typeScriptSources,
    },
    expected: {
      "Service+App+Library": packageNodes,
      InstructionUnit: instructionUnits,
      Decision: decisions,
      units: packageNodes + instructionUnits + decisions,
      scipDocuments: Math.floor(typeScriptSources * 0.6),
    },
  }
}

/** Count top-level `documents` (field 2) in a SCIP index without decoding. */
export function countScipDocuments(bytes: Uint8Array): number {
  let pos = 0
  let documents = 0
  const varint = (): number => {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = bytes[pos++]
      if (byte === undefined) throw new Error("truncated SCIP index")
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
      shift += 7
    }
  }
  while (pos < bytes.length) {
    const tag = varint()
    const wireType = tag % 8
    if (wireType === 0) varint()
    else if (wireType === 2) {
      const length = varint()
      pos += length
    } else if (wireType === 1) pos += 8
    else if (wireType === 5) pos += 4
    else throw new Error(`unsupported wire type ${wireType}`)
    if (Math.floor(tag / 8) === 2) documents++
  }
  return documents
}

/** Measured counts per bound from the repository's unit kinds. */
export function measuredRepoGraph(
  kinds: Record<string, number>,
): Record<string, number> {
  return {
    "Service+App+Library":
      (kinds.Service ?? 0) + (kinds.App ?? 0) + (kinds.Library ?? 0),
    InstructionUnit: kinds.InstructionUnit ?? 0,
    Decision: kinds.Decision ?? 0,
    units: Object.values(kinds).reduce((sum, n) => sum + n, 0),
  }
}

export type RepoGraphSizeRow = {
  name: string
  expected: number
  actual: number | null
  ok: boolean | null
}

/** One row per bound; `ok` is null when that count was not measured. */
export function compareRepoGraph(
  expected: Record<string, number>,
  actual: Record<string, number>,
): RepoGraphSizeRow[] {
  return Object.entries(expected).map(([name, bound]) => {
    const value = actual[name]
    return {
      name,
      expected: bound,
      actual: value ?? null,
      ok: value === undefined ? null : value >= bound,
    }
  })
}

/** Unit kinds the repository's latest completed extraction wrote, at the published projection. */
export async function repositoryUnitKinds(input: {
  orgId: string
  workspaceId: string
  repositoryId: string
}): Promise<Record<string, number>> {
  const [org] = await getSystemDb()
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
  if (!org) throw new Error(`Organization ${input.orgId} not found`)
  return withOrgIdContext(org, async () => {
    const job = await readExtractWriteJob(input.orgId, {
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
    })
    if (!job) throw new Error("No completed extraction for this repository")
    const read = await readRepositoryUnits(
      input.workspaceId,
      Object.values(job.knowledgePaths),
    )
    if (!read.projectionSha)
      throw new Error("Workspace has no published projection")
    return unitKinds(read.units)
  })
}

async function main(argv: string[]): Promise<void> {
  const checkout = flag(argv, "--checkout")
  if (!checkout) throw new Error("--checkout <path> is required")
  const paths = execFileSync("git", ["ls-files", "-z"], {
    cwd: checkout,
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
  const { facts, expected } = estimateRepoGraph(paths)

  const actual: Record<string, number> = {}
  const orgId = flag(argv, "--org-id")
  const workspaceId = flag(argv, "--workspace-id")
  const repositoryId = flag(argv, "--repository-id")
  if (orgId && workspaceId && repositoryId) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error("DATABASE_URL is required")
    initDb(connectionString)
    try {
      const kinds = await repositoryUnitKinds({
        orgId,
        workspaceId,
        repositoryId,
      })
      Object.assign(actual, measuredRepoGraph(kinds))
      facts.unitKinds = Object.keys(kinds).length
      process.stdout.write(`unit kinds: ${JSON.stringify(kinds)}\n`)
    } finally {
      await closeDb()
    }
  }
  const scip = flag(argv, "--scip")
  if (scip) actual.scipDocuments = countScipDocuments(readFileSync(scip))

  process.stdout.write(`checkout: ${JSON.stringify(facts)}\n\n`)
  process.stdout.write(
    "| Count | Expected ≥ | Actual | |\n| --- | --- | --- | --- |\n",
  )
  const rows = compareRepoGraph(expected, actual)
  for (const row of rows) {
    process.stdout.write(
      `| ${row.name} | ${row.expected} | ${row.actual ?? "—"} | ${row.ok === null ? "" : row.ok ? "ok" : "LOW"} |\n`,
    )
  }
  if (rows.some((row) => row.ok === false)) process.exit(1)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  })
}
