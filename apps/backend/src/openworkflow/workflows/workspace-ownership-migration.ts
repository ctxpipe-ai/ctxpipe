import { ownershipMigrationFiles } from "../../domain/ingestion/ownership-migration.js"
import { githubSourcePathsByRepository } from "../../domain/workspace-sources/github-sources.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { log } from "../../observability/logger.js"
import { defineKnowledgeRewriteWorkflow } from "./workspace-knowledge-rewrite.js"

/**
 * The move of old extracted files to ingestion v2 ownership (ADR-052
 * section 3) on a Workspace at format 3 or more. Upgrade step 3 moves the
 * files of the tree that it upgrades. Hydrate queues this job when such a
 * file comes back later, for example from a branch that was made before the
 * upgrade. It is an ingestion v2 publish, so it stops on a tree below
 * format 3.
 */
export const workspaceOwnershipMigration = defineKnowledgeRewriteWorkflow({
  name: "workspace-write-ownership-migration",
  kind: "ownership_migration",
  ingestionV2Publish: true,
  transform: async (files, revision, sourceFiles, orgId) =>
    ownershipMigrationFiles({
      workspaceRepositoryUrl: revision.remote.url,
      sourcePaths: githubSourcePathsByRepository(
        sourceFiles,
        await listWorkspaceSourceRows({
          orgId,
          workspaceId: revision.workspaceId,
        }),
      ),
      files,
      onDroppedClaim: (drop) =>
        log.warn({
          step: "workspace-ownership-migration.claim_dropped",
          workspaceId: revision.workspaceId,
          ...drop,
        }),
    }),
})
