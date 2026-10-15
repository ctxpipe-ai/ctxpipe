import { ownershipMigrationFiles } from "../../domain/ingestion/ownership-migration.js"
import { defineKnowledgeRewriteWorkflow } from "./workspace-knowledge-rewrite.js"

/**
 * The one-time move of old extracted files to ingestion v2 ownership
 * (ADR-052 section 3). Hydrate queues it only while ingestion v2 publishes.
 */
export const workspaceOwnershipMigration = defineKnowledgeRewriteWorkflow({
  name: "workspace-write-ownership-migration",
  kind: "ownership_migration",
  transform: (files, revision) =>
    ownershipMigrationFiles({
      workspaceRepositoryUrl: revision.remote.url,
      files,
    }),
})
