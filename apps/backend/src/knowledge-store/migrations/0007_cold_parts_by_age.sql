-- Old parts move to the cold volume by age (ADR-066 decision 10, CTX-1417).
--
-- The storage policy `default` has the volumes hot and cold. On the hosted
-- node, cold is S3. In Compose and in the tests, cold is a local disk
-- (knowledge-store/clickhouse-storage.xml). Each table gets these items:
-- * written_at: the time when the server writes the row. A changed document
--   gets new rows (DELETE, then INSERT: ADR-066 decision 8), so written_at
--   is the age of the content of the row.
-- * PARTITION BY month of written_at. ClickHouse moves a part when the TTL
--   of all its rows is past. Without partitions, a merge puts old rows and
--   new rows into one part, and that part never moves. Parts of two months
--   never merge.
-- * TTL written_at + 30 days TO VOLUME 'cold'.
--
-- Why 30 days. The hot volume of the hosted node is 100 GB of EBS. The file
-- cache of the cold parts uses 20 GiB of it, and move_factor 0.2 keeps 20%
-- free. Thus the hot parts get about 60 GB. A chunk is about 3 KiB on disk
-- (a full vector of 1024 BFloat16 values is 2 KiB, plus its binary form and
-- its text). 60 GB holds about 20 million chunks that were written in the
-- last 30 to 60 days (one month partition moves when its newest row is 30
-- days old). That is much more than we expect in the first months. A
-- Workspace that nobody changed in 30 days is read less, and the file cache
-- keeps its parts fast when it is read. If the writes become more than the
-- hot volume holds, move_factor moves the largest parts first, so the hot
-- volume does not become full. A projection version change rewrites all
-- rows, and all of them are hot for 30 days.
--
-- ClickHouse cannot change the partition key of a table, so this file drops
-- each table and makes it again. The data is derived from the Workspace Git
-- (ADR-066 decision 11). The projection version (knowledge-plane/
-- change-set.ts) increases with this file, so that each Workspace gets a
-- full rebuild. The columns, the indexes, the CHECK constraints and the row
-- policies are the same as before (0001 to 0006).
--
-- Each statement is idempotent: a second run after a failure changes nothing.

DROP TABLE IF EXISTS documents;

CREATE TABLE documents
(
    org_id String,
    workspace_id String,
    doc_key String,
    kind LowCardinality(String),
    status Enum8('active' = 1, 'deleted' = 2, 'missing' = 3, 'failed' = 4),
    deleted_at Nullable(DateTime64(3, 'UTC')),
    error String DEFAULT '',
    title String DEFAULT '',
    path String DEFAULT '',
    source_type LowCardinality(String) DEFAULT '',
    source String DEFAULT '',
    summary String DEFAULT '',
    mime String DEFAULT '',
    valid_from Nullable(DateTime64(3, 'UTC')),
    valid_to Nullable(DateTime64(3, 'UTC')),
    observed_at DateTime64(3, 'UTC'),
    written_at DateTime('UTC') DEFAULT now(),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, doc_key)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold';

DROP TABLE IF EXISTS chunks;

CREATE TABLE chunks
(
    org_id String,
    workspace_id String,
    doc_key String,
    ordinal UInt32,
    text String,
    start_line UInt32 DEFAULT 0,
    end_line UInt32 DEFAULT 0,
    embedding Array(BFloat16),
    embedding_bits String MATERIALIZED arrayStringConcat(arrayMap(
        i -> char(arraySum(arrayMap(
            j -> bitShiftLeft(toUInt8(embedding[i * 8 + j + 1] > 0), 7 - j),
            range(8)))),
        range(intDiv(length(embedding) + 7, 8)))),
    written_at DateTime('UTC') DEFAULT now(),
    INDEX text_index text TYPE text(tokenizer = splitByNonAlpha),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, doc_key, ordinal)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold'
SETTINGS index_granularity = 64;

DROP TABLE IF EXISTS relations;

CREATE TABLE relations
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
    alt_text String DEFAULT '',
    observed_at DateTime64(3, 'UTC'),
    written_at DateTime('UTC') DEFAULT now(),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, src_doc, src_chunk, predicate, dst_doc)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold';

DROP TABLE IF EXISTS relations_in;

CREATE TABLE relations_in
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
    alt_text String DEFAULT '',
    observed_at DateTime64(3, 'UTC'),
    written_at DateTime('UTC') DEFAULT now(),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, dst_doc, predicate, src_doc)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold';

DROP TABLE IF EXISTS doc_refs;

CREATE TABLE doc_refs
(
    org_id String,
    workspace_id String,
    ref_key String,
    doc_key String,
    written_at DateTime('UTC') DEFAULT now(),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, ref_key, doc_key)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold';

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON documents AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON chunks AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON relations AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON relations_in AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON doc_refs AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;
