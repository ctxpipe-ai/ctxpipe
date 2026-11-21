-- File versions and trees (ADR-071, CTX-1457).
--
-- The content tables hold file versions. A file version is the rows of the
-- content of one file, keyed by (org_id, workspace_id, doc_key, version).
-- doc_key is the key of the path. version is the SHA-256 (32 hex
-- characters) of the blob SHA and the variant of the file (ADR-071 decision
-- 2). A file version is written one time and never changes. All branches of
-- a Workspace share the file versions.
--
-- The table trees says which file version a branch holds at each path. A run
-- inserts the rows of the changed paths with the next tree_version, then
-- moves the head of the branch (knowledge_state in Postgres). A read takes,
-- for each doc_key, the newest row with a tree_version that is not more than
-- the head (ADR-071 decision 4). A tree row has a copy of the fields of its
-- file version that a search filters on, so that the search does not join
-- the documents table. A file version never changes, so a copy never
-- becomes old.
--
-- A `missing` target is not stored (ADR-071 decision 5): a relation target
-- with no tree row is `missing` when it is read. A tombstone is a tree row of
-- kind `deleted` that keeps the version of its last file version.
--
-- The rows are derived data (ADR-066 decision 11), so this file drops the
-- tables and makes them again, with no copy. The projection version
-- (knowledge-plane/change-set.ts) increases with this file, so the next run
-- of each Workspace is a full rebuild. The CHECK constraints, the row
-- policies, the partitions and the TTL are the same as in 0007. The grants
-- of the users come from migrate.ts.
--
-- Each statement is idempotent: a second run after a failure changes nothing.

DROP TABLE IF EXISTS documents;

CREATE TABLE documents
(
    org_id String,
    workspace_id String,
    doc_key String,
    version String,
    kind LowCardinality(String),
    status Enum8('active' = 1, 'failed' = 4),
    error String DEFAULT '',
    title String DEFAULT '',
    path String DEFAULT '',
    source_type LowCardinality(String) DEFAULT '',
    source String DEFAULT '',
    summary String DEFAULT '',
    mime String DEFAULT '',
    valid_to Nullable(DateTime64(3, 'UTC')),
    observed_at DateTime64(3, 'UTC'),
    written_at DateTime('UTC') DEFAULT now(),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, doc_key, version)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold';

DROP TABLE IF EXISTS chunks;

CREATE TABLE chunks
(
    org_id String,
    workspace_id String,
    doc_key String,
    version String,
    ordinal UInt32,
    text String,
    start_line UInt32 DEFAULT 0,
    end_line UInt32 DEFAULT 0,
    embedding Array(BFloat16),
    embedding_key String DEFAULT '',
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
ORDER BY (org_id, workspace_id, doc_key, version, ordinal)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold'
SETTINGS index_granularity = 64;

-- valid_from_introduced: the relation takes its valid_from from the tree row
-- of its source (the time of the commit that introduced the file on the
-- branch), because that time depends on the branch.
DROP TABLE IF EXISTS relations;

CREATE TABLE relations
(
    org_id String,
    workspace_id String,
    src_doc String,
    src_version String,
    src_chunk UInt32,
    predicate LowCardinality(String),
    dst_doc String,
    confidence Float32,
    valid_from Nullable(DateTime64(3, 'UTC')),
    valid_from_introduced Bool DEFAULT false,
    valid_to Nullable(DateTime64(3, 'UTC')),
    source String DEFAULT '',
    alt_text String DEFAULT '',
    observed_at DateTime64(3, 'UTC'),
    written_at DateTime('UTC') DEFAULT now(),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, src_doc, src_version, src_chunk, predicate, dst_doc)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold';

DROP TABLE IF EXISTS relations_in;

CREATE TABLE relations_in
(
    org_id String,
    workspace_id String,
    src_doc String,
    src_version String,
    src_chunk UInt32,
    predicate LowCardinality(String),
    dst_doc String,
    confidence Float32,
    valid_from Nullable(DateTime64(3, 'UTC')),
    valid_from_introduced Bool DEFAULT false,
    valid_to Nullable(DateTime64(3, 'UTC')),
    source String DEFAULT '',
    alt_text String DEFAULT '',
    observed_at DateTime64(3, 'UTC'),
    written_at DateTime('UTC') DEFAULT now(),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, dst_doc, predicate, src_doc, src_version)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold';

DROP TABLE IF EXISTS doc_refs;

CREATE TABLE doc_refs
(
    org_id String,
    workspace_id String,
    ref_key String,
    doc_key String,
    version String,
    written_at DateTime('UTC') DEFAULT now(),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, ref_key, doc_key, version)
TTL written_at + INTERVAL 30 DAY TO VOLUME 'cold';

-- kind: `file` (the path holds the file version `version`) or `deleted` (a
-- tombstone with deleted_at; `version` is the last file version of the
-- path). status, doc_kind, observed_at and valid_to are copies of the file
-- version. valid_from is the time of the commit that introduced the file on
-- the branch.
CREATE TABLE IF NOT EXISTS trees
(
    org_id String,
    workspace_id String,
    branch String,
    doc_key String,
    tree_version UInt64,
    kind Enum8('file' = 1, 'deleted' = 2),
    path String,
    version String,
    status Enum8('active' = 1, 'failed' = 4),
    doc_kind LowCardinality(String) DEFAULT '',
    observed_at DateTime64(3, 'UTC'),
    valid_from Nullable(DateTime64(3, 'UTC')),
    valid_to Nullable(DateTime64(3, 'UTC')),
    deleted_at Nullable(DateTime64(3, 'UTC')),
    written_at DateTime('UTC') DEFAULT now(),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(written_at)
ORDER BY (org_id, workspace_id, branch, doc_key, tree_version)
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

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON trees AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;
