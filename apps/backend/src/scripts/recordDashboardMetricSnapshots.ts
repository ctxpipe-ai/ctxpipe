/**
 * Daily dashboard metric snapshot job.
 *
 * Usage (repo root):
 *   pnpm --filter @ctxpipe/backend run dashboard:snapshot
 *   pnpm --filter @ctxpipe/backend run dashboard:snapshot -- --org-id <uuid>
 */

import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { recordDashboardMetricSnapshot } from "../domain/dashboard.js"
import { initEvlog, log } from "../observability/logger.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

initEvlog()

function parseArgs(argv: string[]): { orgId: string | undefined } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    const next = i >= 0 ? argv[i + 1] : undefined
    return next !== undefined && !next.startsWith("-") ? next : undefined
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    const usage = `Usage:
  pnpm --filter @ctxpipe/backend run dashboard:snapshot
  pnpm --filter @ctxpipe/backend run dashboard:snapshot -- --org-id <uuid>
`
    log.info({ step: "dashboardSnapshot.cli", message: usage })
    process.exit(0)
  }

  return { orgId: get("--org-id") }
}

async function main(): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  initDb(env.DATABASE_URL)

  const { orgId } = parseArgs(process.argv.slice(2))
  const systemDb = getSystemDb()
  const rows = await systemDb
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(orgId ? eq(organizations.id, orgId) : undefined)

  if (orgId && rows.length === 0) {
    log.error({
      step: "dashboardSnapshot.cli",
      message: `No organization found for id=${orgId}`,
      orgId,
    })
    process.exit(1)
  }

  const failures: string[] = []
  try {
    for (const row of rows) {
      try {
        await withOrgIdContext({ id: row.id, slug: row.slug }, () =>
          withOrgDbContext(row.id, () =>
            recordDashboardMetricSnapshot({
              orgId: row.id,
              orgSlug: row.slug,
            }),
          ),
        )
        log.info({
          step: "dashboardSnapshot.org.complete",
          message: "Recorded dashboard metric snapshot",
          orgId: row.id,
          orgSlug: row.slug,
        })
      } catch (err) {
        failures.push(row.id)
        log.error({
          step: "dashboardSnapshot.org.failed",
          message: "Failed to record dashboard metric snapshot",
          orgId: row.id,
          orgSlug: row.slug,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const payload = {
      ok: failures.length === 0,
      processed: rows.length,
      failed: failures.length,
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    if (failures.length > 0) process.exit(1)
  } finally {
    await closeDb()
  }
}

void main()
