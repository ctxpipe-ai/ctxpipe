-- The head of the default branch of each Workspace that a run of the
-- previous release completed (ADR-071 decision 4). The reader and the writer
-- read only knowledge_branch_heads, so without this row a ready Workspace
-- would not be ready until its next commit. The run status is copied: after
-- a stopped run, the next run must delete the tree rows above the head
-- first. knowledge_state keeps its row as the view of the previous release.
-- A second run inserts nothing.
INSERT INTO "knowledge_branch_heads" (
	"workspace_id", "organization_id", "branch", "last_sha", "tree_version",
	"projection_version", "run_status", "failed_count", "default_at",
	"updated_at"
)
SELECT "workspace_id", "organization_id", "branch", "last_sha",
	"tree_version", "projection_version", "run_status", "failed_count",
	"updated_at", "updated_at"
FROM "knowledge_state"
WHERE "last_sha" IS NOT NULL AND "branch" IS NOT NULL
	AND "tree_version" IS NOT NULL
ON CONFLICT ("workspace_id", "branch") DO NOTHING;
