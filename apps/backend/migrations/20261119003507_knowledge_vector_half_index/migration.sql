-- By hand: drizzle-kit writes DROP INDEX "workspace_knowledge_chunks_embedding_idx" and CREATE INDEX
-- "workspace_knowledge_chunks_embedding_half_idx". Drizzle runs every pending migration in one transaction, and a
-- plain index build there would block every write to the chunks for the whole build. So runMigrations builds the new
-- index CONCURRENTLY after the migrations, then drops the old one CONCURRENTLY (src/db/knowledge-vector-index.ts).
SELECT 1;
