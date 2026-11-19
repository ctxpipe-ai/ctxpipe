-- Remake chunks with index_granularity = 64 (ADR-068 decision 1, CTX-1391).
-- The search reads the full vectors of the top 500 chunks only. With the
-- default granularity (8192 rows), 500 random rows touch almost every granule,
-- so the search read almost all full vectors of the Workspace. With 64 rows in
-- a granule, it reads about 46 MiB on 1 million chunks, not 1.5 GiB.
--
-- The table holds no product data when this file runs, so it is dropped and
-- made again. The columns, the text index, the CHECK constraint and the row
-- policy are the same as in 0001_knowledge_tables.sql. The block number and
-- block offset columns are not set: the writer uses DELETE and INSERT only,
-- never the lightweight UPDATE (CTX-1401).

DROP TABLE IF EXISTS chunks;

CREATE TABLE chunks
(
    org_id String,
    workspace_id String,
    doc_key String,
    ordinal UInt32,
    text String,
    embedding Array(BFloat16),
    embedding_bits String MATERIALIZED arrayStringConcat(arrayMap(
        i -> char(arraySum(arrayMap(
            j -> bitShiftLeft(toUInt8(embedding[i * 8 + j + 1] > 0), 7 - j),
            range(8)))),
        range(intDiv(length(embedding) + 7, 8)))),
    INDEX text_index text TYPE text(tokenizer = splitByNonAlpha),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
ORDER BY (org_id, workspace_id, doc_key, ordinal)
SETTINGS index_granularity = 64;

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON chunks AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;
