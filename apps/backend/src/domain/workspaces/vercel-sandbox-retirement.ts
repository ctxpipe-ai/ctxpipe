import { APIError } from "@vercel/sandbox"

import { withOrgDbContext } from "../../db/client.js"
import {
  deleteSandboxInstance,
  listSandboxInstances,
  ownershipOf,
  type SandboxInstanceRecord,
} from "../../models/workspace-sandboxes.js"
import { log } from "../../observability/logger.js"
import {
  destroyDetachedProviderSandbox,
  lockedSandboxProvider,
} from "./sandbox-provider.js"
import { deleteWorkspaceBaseArtifacts } from "./workspace-base-providers.js"

/**
 * Retire the org's `vercel` sandbox rows (CTX-1220, ADR-061 decision 18).
 * Hosted sandboxes moved to AgentCore, and Vercel still keeps the Workspace
 * base snapshots (copies of customer repositories) and the conversation,
 * job and ingest sandboxes of the earlier rows. The org's sandbox sweep
 * calls this first. For each row, it deletes the Vercel resource with the
 * existing provider code (a base: its builder and snapshots; another kind:
 * the sandbox, its snapshots and its GitHub token), then the row. A Vercel
 * 404 counts as deleted. A row whose delete fails stays, and the sweep runs
 * again at the next retry. Bases go last, after the sandboxes that can have
 * started from them.
 *
 * It does nothing while the deployment locks `SANDBOX_PROVIDER=vercel` (a
 * rollback to Vercel). The worker holds `VERCEL_TOKEN` until the Vercel
 * provider code goes, and that code refuses to start while a `vercel` row
 * stays. Logs hold counts and HTTP status codes only.
 */
export async function retireVercelSandboxes(
  orgId: string,
): Promise<{ retired: number; failed: number }> {
  if (lockedSandboxProvider() === "vercel") return { retired: 0, failed: 0 }
  const rows = (
    await withOrgDbContext(orgId, () => listSandboxInstances({}))
  ).filter((row) => row.provider === "vercel")
  let retired = 0
  let failed = 0
  for (const row of [
    ...rows.filter((item) => item.kind !== "base"),
    ...rows.filter((item) => item.kind === "base"),
  ]) {
    try {
      await deleteAtVercel(row)
      // Only while the row is the one that was read: a row that another
      // writer changed stays for the next sweep.
      await deleteSandboxInstance(row.id, row.orgId, ownershipOf(row))
      retired += 1
    } catch (error) {
      failed += 1
      // The error text can hold a snapshot id: log the kind and status only.
      log.warn({
        step: "vercel-sandbox-retirement",
        message: `Retiring a Vercel sandbox failed (kind ${row.kind})`,
        kind: row.kind,
        status:
          error instanceof APIError
            ? error.response.status
            : "not-an-api-error",
      })
    }
  }
  if (rows.length)
    log.info({
      step: "vercel-sandbox-retirement",
      message: `Retired ${retired} Vercel sandboxes, ${failed} failed`,
      retired,
      failed,
    })
  return { retired, failed }
}

async function deleteAtVercel(row: SandboxInstanceRecord): Promise<void> {
  try {
    if (row.kind === "base") await deleteWorkspaceBaseArtifacts(row)
    else if (row.providerSandboxId)
      await destroyDetachedProviderSandbox({
        orgId: row.orgId,
        provider: "vercel",
        providerSandboxId: row.providerSandboxId,
      })
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) return
    throw error
  }
}
