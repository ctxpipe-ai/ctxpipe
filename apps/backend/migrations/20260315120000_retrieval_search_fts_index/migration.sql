-- GIN index for full-text search on retrieval_search.content
-- Used by bm25Search.ts: to_tsvector('english', rs.content) @@ plainto_tsquery(...)
CREATE INDEX IF NOT EXISTS "retrieval_search_content_fts_idx"
  ON "retrieval_search" USING gin(to_tsvector('english', "content"));
