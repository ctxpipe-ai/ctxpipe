/**
 * The one-time cleanup of the GitHub pull request and issue mirrors of one
 * Workspace (CTX-1693): mixed-case owner folders from before 2026-10-20, and
 * the mirrors of repositories that left the sources.
 *
 * With no `--apply`, it is a dry run: it reads the tip of the default branch
 * and logs counts only (duplicates, moves, removed-source folders and files,
 * skipped files). It writes nothing. With `--apply`, it queues the host write
 * job `github_mirror_cleanup`. The worker plans again on the tip, and makes
 * one direct commit through the write broker.
 *
 * A run of this script in production is an ops action that a human approves:
 * first the dry run, then the apply, each one a reviewed command.
 *
 *   bun run src/scripts/cleanupGithubMirrors.ts --org <orgId> --workspace <workspaceId> [--apply]
 */
import { parseArgs } from "node:util"

import { withOrgIdContext } from "../auth/withAuth.js"
import { parseEnv } from "../config/env.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { dryRunGithubMirrorCleanup } from "../domain/workspaces/github-mirror-cleanup.js"
import { generateObjectId } from "../lib/id.js"
import { flushEvlog, initEvlog, log } from "../observability/logger.js"

initEvlog()
let exitCode = 0
const { values } = parseArgs({
  options: {
    org: { type: "string" },
    workspace: { type: "string" },
    apply: { type: "boolean", default: false },
  },
})
const { org: orgId, workspace: workspaceId, apply } = values
try {
  if (!orgId || !workspaceId)
    throw new Error("Usage: --org <orgId> --workspace <workspaceId> [--apply]")
  const env = parseEnv(process.env)
  initDb(env.DATABASE_URL)
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: orgId } },
  })
  if (!org) throw new Error("Organization not found")
  await withOrgIdContext(org, async () => {
    if (!apply) {
      log.info({
        step: "github_mirror_cleanup.dry_run",
        message: "Dry run of the GitHub mirror cleanup: nothing was written",
        orgId,
        workspaceId,
        ...(await dryRunGithubMirrorCleanup({ orgId, workspaceId, env })),
      })
      return
    }
    // A dynamic import: the OpenWorkflow client connects when it loads.
    const { enqueueWriteJob } =
      await import("../openworkflow/enqueue-workspace-write-commit.js")
    const { closeOpenWorkflowClient } =
      await import("../openworkflow/client.js")
    try {
      const jobId = generateObjectId("wjob")
      const { started } = await enqueueWriteJob(
        { orgId, workspaceId, jobId, kind: "github_mirror_cleanup" },
        {
          error: (error) =>
            log.error({
              step: "github_mirror_cleanup.apply",
              message: error.message,
              orgId,
              workspaceId,
            }),
        },
      )
      if (!started) throw new Error("Admission refused the cleanup job")
      log.info({
        step: "github_mirror_cleanup.apply",
        message: "Queued the GitHub mirror cleanup job",
        orgId,
        workspaceId,
        jobId,
      })
    } finally {
      await closeOpenWorkflowClient()
    }
  })
} catch (error) {
  exitCode = 1
  log.error({
    step: "github_mirror_cleanup",
    message: error instanceof Error ? error.message : String(error),
    orgId,
    workspaceId,
  })
} finally {
  await closeDb()
}
await flushEvlog()
process.exit(exitCode)
