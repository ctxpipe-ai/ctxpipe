-- By hand: drizzle-kit does not make extensions. btree_gin lets the GIN index hold the org.
CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
DROP INDEX "workspace_knowledge_chunks_search_idx";--> statement-breakpoint
CREATE INDEX "workspace_knowledge_chunks_search_idx" ON "workspace_knowledge_chunks" USING gin (("org_id" COLLATE "C"),"search");--> statement-breakpoint
-- By hand: drizzle-kit writes DROP VIEW and CREATE VIEW. CREATE OR REPLACE keeps the app role's SELECT grant
-- until provisionAppRole runs after the migrations.
CREATE OR REPLACE VIEW "workspace_knowledge_chunk_search" WITH (check_option = cascaded) AS (SELECT workspace_id, unit_id, chunk_hash, occurrence, search FROM workspace_knowledge_chunks WHERE ("org_id" COLLATE "C") = current_setting('app.organization_id', true));
