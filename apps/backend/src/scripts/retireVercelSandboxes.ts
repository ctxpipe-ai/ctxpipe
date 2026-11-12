/**
 * One-time retirement of the hosted Vercel sandboxes (CTX-1220, ADR-061
 * decision 18). For each sandbox row whose provider is `vercel` (Workspace
 * bases with their builders and snapshots, and conversation, job and ingest
 * sandboxes), it deletes the Vercel resource with the provider code, then
 * deletes the row. A sandbox row that does not exist is the retired state:
 * the code that removes the Vercel provider can refuse to start while
 * `countVercelSandboxes` is not zero. A second run finds nothing to do.
 *
 *   bun src/scripts/retireVercelSandboxes.ts [--dry-run]
 *
 * It reads DATABASE_URL, and VERCEL_TOKEN, VERCEL_TEAM_ID and
 * VERCEL_PROJECT_ID (not with --dry-run). It logs counts only: never an org,
 * a repository, a sandbox or snapshot id, or a token.
 */
import { APIError } from "@vercel/sandbox"

import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import {
  deleteVercelBuilder,
  deleteVercelSandbox,
  type VercelCredentials,
  vercelCredentials,
} from "../domain/workspaces/vercel-sandbox-provider.js"
import {
  deleteSandboxInstance,
  listSandboxInstances,
  ownershipOf,
  type SandboxInstanceKind,
  type SandboxInstanceRecord,
} from "../models/workspace-sandboxes.js"
import { log } from "../observability/logger.js"

type KindCounts = Record<SandboxInstanceKind, number>

function noKinds(): KindCounts {
  return { chat: 0, job: 0, base: 0, ingest: 0 }
}

/** The `vercel` sandbox rows of the orgs (default: every org). */
async function vercelSandboxRows(
  orgIds?: readonly string[],
): Promise<SandboxInstanceRecord[]> {
  const ids =
    orgIds ??
    (
      await getSystemDb()
        .select({ id: organizations.id })
        .from(organizations)
        .orderBy(organizations.id)
    ).map((org) => org.id)
  const rows: SandboxInstanceRecord[] = []
  // Row-level security shows the sandboxes of an org only in its own context.
  for (const orgId of ids)
    rows.push(
      ...(await withOrgDbContext(orgId, () => listSandboxInstances({}))).filter(
        (row) => row.provider === "vercel",
      ),
    )
  return rows
}

/** The `vercel` sandbox rows that are not retired, by kind. */
export async function countVercelSandboxes(
  orgIds?: readonly string[],
): Promise<KindCounts> {
  const counts = noKinds()
  for (const row of await vercelSandboxRows(orgIds)) counts[row.kind] += 1
  return counts
}

/** Delete what the row holds at Vercel. A 404 counts as deleted. */
async function deleteAtVercel(
  credentials: VercelCredentials,
  row: SandboxInstanceRecord,
): Promise<void> {
  try {
    if (row.kind === "base")
      await deleteVercelBuilder({
        credentials,
        builderName: row.providerSandboxId,
        snapshotId: row.latestSnapshotId,
      })
    // No GitHub token store: a stopped sandbox's token is already revoked,
    // and a running one's expires within an hour.
    else if (row.providerSandboxId)
      await deleteVercelSandbox({ credentials, name: row.providerSandboxId })
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) return
    throw error
  }
}

/**
 * Retire every `vercel` sandbox row of the orgs (default: every org). Bases
 * go last, after the sandboxes that can have started from them. A row whose
 * Vercel delete fails stays as it is; the other rows are retired, and the
 * caller sees the failures in `failed`. `dryRun` counts the rows and changes
 * nothing.
 */
export async function retireVercelSandboxes(input: {
  credentials?: VercelCredentials
  dryRun?: boolean
  orgIds?: readonly string[]
}): Promise<{ found: KindCounts; retired: KindCounts; failed: KindCounts }> {
  const rows = await vercelSandboxRows(input.orgIds)
  const found = noKinds()
  const retired = noKinds()
  const failed = noKinds()
  for (const row of rows) found[row.kind] += 1
  if (input.dryRun || rows.length === 0) return { found, retired, failed }
  const credentials = input.credentials ?? (await vercelCredentials())
  const ordered = [
    ...rows.filter((row) => row.kind !== "base"),
    ...rows.filter((row) => row.kind === "base"),
  ]
  for (const row of ordered) {
    try {
      await deleteAtVercel(credentials, row)
      // Only while the row is the one that was read: a row that another
      // writer changed stays, and the next run reads it again.
      await deleteSandboxInstance(row.id, row.orgId, ownershipOf(row))
      retired[row.kind] += 1
    } catch (error) {
      failed[row.kind] += 1
      // The error text can hold a snapshot id: log only the kind and status.
      log.warn({
        step: "retire-vercel-sandboxes",
        message: `Retiring a sandbox failed (kind ${row.kind})`,
        kind: row.kind,
        status:
          error instanceof APIError
            ? error.response.status
            : "not-an-api-error",
      })
    }
  }
  return { found, retired, failed }
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run")
  const url = process.env.DATABASE_URL
  if (!url) {
    process.stderr.write("retireVercelSandboxes needs DATABASE_URL\n")
    process.exit(1)
  }
  initDb(url)
  retireVercelSandboxes({ dryRun })
    .then(async ({ found, retired, failed }) => {
      log.info({
        step: "retire-vercel-sandboxes",
        message: dryRun
          ? "Counted the Vercel sandboxes to retire"
          : "Retired the Vercel sandboxes",
        dryRun,
        found,
        retired,
        failed,
      })
      await closeDb()
      const failures = Object.values(failed).reduce((a, b) => a + b, 0)
      if (failures > 0) {
        process.stderr.write(
          `${failures} Vercel sandboxes are not retired; run the script again\n`,
        )
        process.exit(1)
      }
    })
    .catch((error: unknown) => {
      // Not the error text: it can name a sandbox or a snapshot.
      process.stderr.write(
        `Retiring the Vercel sandboxes failed (${error instanceof Error ? error.name : "unknown error"})\n`,
      )
      process.exit(1)
    })
}
