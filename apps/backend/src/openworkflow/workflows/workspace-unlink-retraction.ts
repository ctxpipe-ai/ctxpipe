import { z } from "zod"

import {
  retiredPublishPipelineField,
  workspacePublishPipeline,
} from "../../domain/ingestion/ingestion-v2-config.js"
import { planUnlinkRetraction } from "../../domain/ingestion/unlink-retraction.js"
import { checkSourcePath } from "../../domain/workspace-sources/source-file.js"
import { readSourcesTree } from "../../domain/workspace-sources/source-tree.js"
import { githubMirrorPathsOf } from "../../domain/workspaces/github-mirror-cleanup.js"
import { workspaceRevisionSchema } from "../../domain/workspaces/revision.js"
import { packWorkspaceFormat } from "../../domain/workspaces/workspace-format-tree.js"
import { sourcesHoldRepository } from "../../models/workspace-source-state.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import {
  getWriteJobUnchangedFiles,
  persistWriteJobUnchangedFiles,
} from "../../models/workspace-write-jobs.js"
import { getLogger } from "../../observability/logger.js"
import { defineReplanningHostWriteWorkflow } from "./workspace-replanning-host-write.js"

export const workspaceUnlinkRetractionInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    jobId: z.string().min(1),
    revision: workspaceRevisionSchema,
    /** The source repository that left the sources. */
    retractRepositoryUrl: z.string().min(1),
    /**
     * The source file of that repository that the merged revision removed
     * (ADR-050 revision 2026-10-16). The files of the repository list it in
     * `sources`.
     */
    retractSourcePath: z
      .string()
      .refine((path) => checkSourcePath(path).ok, "Use a source file path"),
    /** Retired: a job that was queued with it still parses. */
    publishPipeline: retiredPublishPipelineField,
  })
  .strict()
  .refine(
    (input) =>
      input.workspaceId === input.revision.workspaceId &&
      input.revision.access === "write-default",
    "A write-default revision for the matching workspace is required",
  )

/**
 * The host retraction of a repository source that a merged revision removed
 * (CTX-720 on the CTX-710 path). The projection of that revision queues it
 * (`enqueueSourceProjectionFollowUps`). A person approved the removal when
 * they merged it, so the retraction is a direct host commit, as the cleanup
 * of a removed connector source is.
 *
 * - The plan reads the sources at the tip. When a source names the
 *   repository again, or a source file cannot be read, it retracts nothing.
 * - The plan also deletes the GitHub pull request and issue mirror files of
 *   the repository (`github/pulls/<owner>/<repo>/` and
 *   `github/issues/<owner>/<repo>/`), also in an old mixed-case folder.
 * - Only ingestion v2 owns files that a retraction can remove (ADR-052
 *   section 3), so the plan retracts nothing on a tree below format 3
 *   (ADR-052 phase 4, G5). The plan reads the tree that the push lands on:
 *   the push lands only on that parent.
 * - A lost push race plans again on the new tip. It never goes through the
 *   semantic merge, because that would push the old plan with no new check.
 */
export function defineWorkspaceUnlinkRetractionWorkflow() {
  return defineReplanningHostWriteWorkflow({
    name: "workspace-write-unlink-retraction",
    kind: "unlink_retraction",
    schema: workspaceUnlinkRetractionInputSchema,
    claim: (input) => ({
      retractRepositoryUrl: input.retractRepositoryUrl,
      retractSourcePath: input.retractSourcePath,
    }),
    change: async (input, { pack, read, revision, createdAt }) => {
      const plan = await (async () => {
        const none: Awaited<ReturnType<typeof planUnlinkRetraction>> = {
          files: [],
          deletePaths: [],
          skipped: [],
        }
        if (
          workspacePublishPipeline(await packWorkspaceFormat(pack, read)) !==
          "v2"
        )
          return none
        // The CTX-710 fence: a repository that a source names again
        // keeps its files, also when that entry is invalid for now.
        // The tip text gives an invalid entry no scope, so a stored
        // row that still holds the repository also keeps it.
        if (
          await sourcesHoldRepository(
            await readSourcesTree(pack, read),
            await listWorkspaceSourceRows(input),
            input.retractRepositoryUrl,
          )
        )
          return none
        const plan = await planUnlinkRetraction({
          pack,
          read,
          sourceUrl: input.retractRepositoryUrl,
          sourcePath: input.retractSourcePath,
          workspaceRepositoryUrl: revision.remote.url,
          observedAt: new Date(createdAt).toISOString(),
        })
        // A file that the validator cannot delete stays. The job
        // result lists it, so the retraction does not fail forever.
        if (plan.skipped.length)
          getLogger().warn(
            "The unlink retraction left files outside the allowed knowledge folders unchanged",
            {
              workspaceId: input.workspaceId,
              jobId: input.jobId,
              skipped: plan.skipped,
            },
          )
        // The pull request and issue mirrors of the repository go in
        // the same commit (CTX-1698).
        const mirrors = await githubMirrorPathsOf({
          pack,
          read,
          repositoryUrl: input.retractRepositoryUrl,
        })
        return {
          ...plan,
          deletePaths: [...plan.deletePaths, ...mirrors].sort(),
        }
      })()
      // The list of skipped files can be long: the job keeps
      // it, not the step output (CTX-1239).
      await persistWriteJobUnchangedFiles(input.jobId, {
        skipped: plan.skipped,
      })
      return { files: plan.files, deletePaths: plan.deletePaths }
    },
    subject: { trigger: "unlink_retraction" },
    // The files that the retraction cannot delete, from the job: the
    // step that planned them recorded them there.
    result: async (input) => ({
      skipped: (await getWriteJobUnchangedFiles(input.jobId)).skipped ?? [],
    }),
  })
}

export const workspaceUnlinkRetraction =
  defineWorkspaceUnlinkRetractionWorkflow()
