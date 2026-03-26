/**
 * Rerun Phase-2 skill derivation (deriveSkillsFromUnits) from persisted InstructionUnit
 * rows only — no LLM, no file reads. Writes Skill objects + MEMBER_OF_PRIMARY claims,
 * then runs the same store → project → embed chain as ingestion.
 *
 * Usage (from repo root):
 *   pnpm --filter @ctxpipe/backend run rerun-skill-derivation -- --org-id <uuid> --repository-id <id> [--target-hash <hash>] [--skip-embed]
 *
 * Env: same as backend (`apps/backend/.env.local`): DATABASE_URL, AUTH_SECRET, GRAPH_DB_URI,
 * and embedding vars unless --skip-embed.
 */

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { and, eq, sql } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import {
  closeDb,
  getOrgDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../db/client.js"
import { retrievalObjects } from "../db/schema/retrieval_objects.js"
import { deduplicateAndStore } from "../graphs/codeIngestionGraph/nodes/deduplicateAndStore.js"
import { embed } from "../graphs/codeIngestionGraph/nodes/embed.js"
import { deriveSkillsFromUnits } from "../graphs/codeIngestionGraph/nodes/extractInstructionUnits.js"
import { project } from "../graphs/codeIngestionGraph/nodes/project.js"
import type {
  CodeIngestionState,
  ExtractedObject,
} from "../graphs/codeIngestionGraph/schemas.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

function parseArgs(argv: string[]): {
  orgId: string
  repositoryId: string
  targetHash: string | undefined
  skipEmbed: boolean
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")
      ? argv[i + 1]
      : undefined
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage:
  bun run src/scripts/rerunSkillDerivation.ts -- --org-id <uuid> --repository-id <id> [options]

Options:
  --target-hash <git-sha>   Defaults to payload.target_hash on units, else repository.last_ingested_hash
  --skip-embed              Skip embedding / bm25 update (Postgres + graph still updated)
`)
    process.exit(0)
  }
  const orgId = get("--org-id")
  const repositoryId = get("--repository-id")
  const targetHash = get("--target-hash")
  const skipEmbed = argv.includes("--skip-embed")
  if (!orgId || !repositoryId) {
    console.error("Missing required --org-id and --repository-id")
    process.exit(1)
  }
  return { orgId, repositoryId, targetHash, skipEmbed }
}

function rowToExtractedObject(row: {
  kind: string
  deduplicationKey: string | null
  payload: unknown
}): ExtractedObject | null {
  if (!row.deduplicationKey) return null
  const payload =
    typeof row.payload === "object" && row.payload !== null
      ? (row.payload as Record<string, unknown>)
      : {}
  return {
    kind: row.kind as ExtractedObject["kind"],
    deduplicationKey: row.deduplicationKey,
    name: typeof payload.name === "string" ? payload.name : undefined,
    summary: typeof payload.summary === "string" ? payload.summary : undefined,
    payload,
  }
}

export async function rerunSkillDerivationFromDb(input: {
  orgId: string
  orgSlug: string
  repositoryId: string
  targetHash?: string
  skipEmbed?: boolean
}): Promise<{
  skillObjectCount: number
  skillClaimCount: number
  targetHash: string
}> {
  const { orgId, orgSlug, repositoryId, skipEmbed = false } = input

  return withOrgIdContext({ id: orgId, slug: orgSlug }, () =>
    withOrgDbContext(orgId, async () => {
      const db = getOrgDb()

      const repo = await db.query.repositories.findFirst({
        where: {
          id: { eq: repositoryId },
          orgId: { eq: orgId },
        },
      })
      if (!repo) {
        throw new Error(
          `Repository not found for org: repositoryId=${repositoryId} orgId=${orgId}`,
        )
      }

      const prefix = `inu:${repositoryId}:`
      const rows = await db
        .select({
          kind: retrievalObjects.kind,
          deduplicationKey: retrievalObjects.deduplicationKey,
          payload: retrievalObjects.payload,
        })
        .from(retrievalObjects)
        .where(
          and(
            eq(retrievalObjects.orgId, orgId),
            eq(retrievalObjects.kind, "InstructionUnit"),
            sql`${retrievalObjects.deduplicationKey} LIKE ${`${prefix}%`}`,
          ),
        )

      const units: ExtractedObject[] = []
      for (const r of rows) {
        const o = rowToExtractedObject(r)
        if (o) units.push(o)
      }

      let targetHash = input.targetHash
      if (!targetHash) {
        for (const u of units) {
          const th = (u.payload as { target_hash?: string } | undefined)
            ?.target_hash
          if (typeof th === "string" && th.length > 0) {
            targetHash = th
            break
          }
        }
      }
      if (!targetHash) {
        targetHash = repo.lastIngestedHash ?? undefined
      }
      if (!targetHash) {
        throw new Error(
          "Could not resolve targetHash: pass --target-hash or ensure units have payload.target_hash or repository.last_ingested_hash is set",
        )
      }

      const { objects: skillObjects, claims: skillClaims } =
        deriveSkillsFromUnits({
          repositoryId,
          targetHash,
          units,
        })

      if (skillObjects.length === 0) {
        return {
          skillObjectCount: 0,
          skillClaimCount: 0,
          targetHash,
        }
      }

      const state: CodeIngestionState = {
        repositoryId,
        orgId,
        targetHash,
        extractedObjects: skillObjects,
        extractedClaims: skillClaims,
      }

      const stored = await deduplicateAndStore(state)
      await project({ ...state, ...stored })
      if (!skipEmbed) {
        await embed({ ...state, ...stored })
      }

      return {
        skillObjectCount: skillObjects.length,
        skillClaimCount: skillClaims.length,
        targetHash,
      }
    }),
  )
}

async function main(): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  initDb(env.DATABASE_URL)

  const { orgId, repositoryId, targetHash, skipEmbed } = parseArgs(
    process.argv.slice(2),
  )

  const systemDb = getSystemDb()
  const org = await systemDb.query.organizations.findFirst({
    where: { id: { eq: orgId } },
  })
  if (!org) {
    console.error(`Organization not found: ${orgId}`)
    process.exit(1)
  }

  try {
    const result = await rerunSkillDerivationFromDb({
      orgId,
      orgSlug: org.slug,
      repositoryId,
      targetHash,
      skipEmbed,
    })
    console.log(
      JSON.stringify(
        {
          ok: true,
          ...result,
        },
        null,
        2,
      ),
    )
  } finally {
    await closeDb()
  }
}

void main()
