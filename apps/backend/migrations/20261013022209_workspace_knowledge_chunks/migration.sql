CREATE TABLE "workspace_knowledge_chunks" (
	"unit_id" text,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"projection_sha" text,
	"ordinal" integer,
	"text" text NOT NULL,
	"search" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED NOT NULL,
	"embedding" vector(2000),
	"chunk_hash" text NOT NULL,
	CONSTRAINT "workspace_knowledge_chunks_pkey" PRIMARY KEY("unit_id","projection_sha","ordinal")
);
--> statement-breakpoint
ALTER TABLE "workspace_knowledge_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_workspace_id_sha_idx" ON "workspace_knowledge_chunks" ("workspace_id","projection_sha");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_workspace_id_hash_idx" ON "workspace_knowledge_chunks" ("workspace_id","chunk_hash");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_org_id_idx" ON "workspace_knowledge_chunks" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_search_idx" ON "workspace_knowledge_chunks" USING gin ("search");--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_embedding_idx" ON "workspace_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "workspace_knowledge_chunks" ADD CONSTRAINT "workspace_knowledge_chunks_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_knowledge_chunks" AS PERMISSIVE FOR ALL TO public USING ("workspace_knowledge_chunks"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_knowledge_chunks"."org_id" = current_setting('app.organization_id', true));