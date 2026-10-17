import { importKeyCleanupFiles } from "../../domain/workspaces/hydrate-write-jobs.js"
import { defineKnowledgeRewriteWorkflow } from "./workspace-knowledge-rewrite.js"

export const workspaceImportKeyCleanup = defineKnowledgeRewriteWorkflow({
  name: "workspace-write-import-key-cleanup",
  kind: "import_key_cleanup",
  requireExportedFormat: true,
  transform: (files) => importKeyCleanupFiles(files),
})
