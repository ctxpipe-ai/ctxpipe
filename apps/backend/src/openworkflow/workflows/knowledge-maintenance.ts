import { createHash } from "node:crypto"

import { z } from "zod"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { workspaceGitRead } from "../../domain/workspaces/resolve-revision.js"
import { workspaceRootPath } from "../../domain/workspaces/root-path.js"
import { findKnowledgeRepairs } from "../../knowledge-plane/maintenance.js"
import { createKnowledgeStore } from "../../knowledge-store/knowledge-store.js"
import { getKnowledgeState } from "../../models/knowledge-state.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { enqueueWriteJob } from "../enqueue-workspace-write-commit.js"

/**
 * The maintenance job of the knowledge plane (ADR-067 decision 9). The
 * projection writer queues one run for each tip that it applies.
 *
 * A run reads the `deleted`, `missing` and `failed` documents of the
 * Workspace (`findKnowledgeRepairs`). It writes one finding event, and it
 * queues one Workspace write job with the safe fixes. The fixes come back
 * through a normal hydrate run. The job never deletes content and never
 * changes a row.
 *
 * A run is idempotent for each tip: the write job has one id for each
 * Workspace and tip. A run for a tip that is not `last_sha` any more does
 * nothing, because the run of the later tip checks the newer rows.
 */
export const knowledgeMaintenance = defineWorkflow(
  {
    name: "knowledge-maintenance",
    schema: z
      .object({
        orgId: z.string().min(1),
        workspaceId: z.string().min(1),
        /** The tip that the writer applied. */
        sha: z.string().min(1),
      })
      .strict(),
    logFields: (input) => ({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
    }),
  },
  async ({ input, step }) =>
    step.run({ name: "maintain" }, async () => {
      const env = parseEnv(process.env)
      const key = { orgId: input.orgId, workspaceId: input.workspaceId }
      const [state, workspace, org] = await Promise.all([
        getKnowledgeState(key),
        withOrgDbContext(input.orgId, () =>
          getWorkspaceById(input.workspaceId, input.orgId),
        ),
        getSystemDb().query.organizations.findFirst({
          where: { id: { eq: input.orgId } },
        }),
      ])
      if (state?.lastSha !== input.sha || !workspace || !org) {
        getLogger().set({
          knowledgeMaintenance: { sha: input.sha, outcome: "superseded" },
        })
        return { outcome: "superseded" as const }
      }
      // The worker has only the writer user (ADR-066 decision 9). The job
      // uses only its reads.
      const store = createKnowledgeStore(env.CLICKHOUSE_URL)
      const found = await findKnowledgeRepairs({
        ...key,
        remote: workspaceGitRead({
          orgId: input.orgId,
          env,
          remote: {
            url: workspace.workspaceRepositoryUrl,
            connectionId: workspace.githubConnectionId,
          },
        }),
        root: workspaceRootPath(workspace),
        sha: input.sha,
        store,
      }).finally(() => store.close())

      let writeJob: { id: string; started: boolean } | null = null
      if (found.files.length) {
        const id = `wjob_km_${createHash("sha256")
          .update(`${input.workspaceId}\0${input.sha}`)
          .digest("hex")
          .slice(0, 32)}`
        // The job binds the tip of the findings. When the default branch
        // moved, admission refuses it, and the run of the new tip fixes the
        // link. Admission reads the Workspace in the org context.
        const { started } = await withOrgIdContext(org, () =>
          enqueueWriteJob(
            {
              ...key,
              jobId: id,
              kind: "knowledge_maintenance",
              jobDesiredSha: input.sha,
              mergeFiles: found.files,
              mergeDeletePaths: [],
            },
            { error: (error) => getLogger().error(error) },
          ),
        )
        writeJob = { id, started }
      }
      const summary = {
        outcome: "checked" as const,
        counts: found.counts,
        findingCount: found.findings.length,
        // Paths are Workspace content. The hydrate logs hold them too, but
        // the event keeps only the first 50 findings.
        findings: found.findings.slice(0, 50),
        rewrittenFiles: found.files.length,
        writeJob,
      }
      getLogger().set({ knowledgeMaintenance: { sha: input.sha, ...summary } })
      return summary
    }),
)
