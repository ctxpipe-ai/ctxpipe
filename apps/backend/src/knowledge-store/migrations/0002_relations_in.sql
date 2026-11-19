-- The incoming relations get their own table (ADR-066 decision 3, CTX-1391).
-- One patch part anywhere in a table stops every read from using any
-- projection of that table, and a DELETE on a table with a projection
-- rewrites whole parts. Thus the projection by_dst goes, and relations_in
-- holds the same rows as relations, sorted by dst_doc. KnowledgeStore writes
-- and deletes both tables. The tables hold no product data yet, so the
-- migration does not copy rows.
--
-- relations_in has the same CHECK constraint and the same row policy as the
-- other knowledge tables (see 0001_knowledge_tables.sql).
--
-- KnowledgeStore writes no patch parts (ADR-066 decision 8): each change is
-- the classic lightweight DELETE, then an INSERT. Only patch parts need the
-- block number and block offset columns, so the tables stop making them.
--
-- Each statement is idempotent: a second run after a failure changes nothing.

ALTER TABLE relations DROP PROJECTION IF EXISTS by_dst;

ALTER TABLE relations RESET SETTING lightweight_mutation_projection_mode,
    enable_block_number_column, enable_block_offset_column;

ALTER TABLE documents RESET SETTING
    enable_block_number_column, enable_block_offset_column;

ALTER TABLE chunks RESET SETTING
    enable_block_number_column, enable_block_offset_column;

CREATE TABLE IF NOT EXISTS relations_in
(
    org_id String,
    workspace_id String,
    src_doc String,
    src_chunk UInt32,
    predicate LowCardinality(String),
    dst_doc String,
    confidence Float32,
    valid_from Nullable(DateTime64(3, 'UTC')),
    valid_to Nullable(DateTime64(3, 'UTC')),
    source String DEFAULT '',
    observed_at DateTime64(3, 'UTC'),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
ORDER BY (org_id, workspace_id, dst_doc, predicate, src_doc);

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON relations_in AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;
