-- The knowledge content tables of ADR-066 decision 3. All Workspaces share
-- them. Each table sorts by (org_id, workspace_id, ...) first.
--
-- Org isolation (ADR-066 decision 9). KnowledgeStore sets the custom setting
-- SQL_ctxpipe_org_id on each statement. The stock server accepts custom
-- settings with the prefix SQL_ (server setting custom_settings_prefixes).
-- * The CHECK constraint org_wall refuses an inserted row of another org.
-- * The row policy knowledge_org_wall (at the end of this file) filters each
--   read to the org of the setting.
-- If the setting is not set, getSetting fails, so a statement without an org
-- fails and returns no rows.
--
-- The block number and block offset columns let the lightweight UPDATE write
-- patch parts (ADR-066 decision 8).
--
-- Each statement is idempotent: a second run after a failure changes nothing.

CREATE TABLE IF NOT EXISTS documents
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
    s3_key String DEFAULT '',
    mime String DEFAULT '',
    valid_from Nullable(DateTime64(3, 'UTC')),
    valid_to Nullable(DateTime64(3, 'UTC')),
    observed_at DateTime64(3, 'UTC'),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
ORDER BY (org_id, workspace_id, doc_key)
SETTINGS enable_block_number_column = 1, enable_block_offset_column = 1;

-- embedding: the full vector. embedding_bits: its binary form (ADR-068
-- decision 1), which the server calculates from embedding. Bit 7 - j of byte i
-- is 1 when dimension 8 * i + j is more than 0. The last byte is filled with
-- 0 bits. bitHammingDistance compares two binary forms. The text index gives
-- the lexical search on text.
CREATE TABLE IF NOT EXISTS chunks
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
SETTINGS enable_block_number_column = 1, enable_block_offset_column = 1;

-- A relation belongs to the document that states it (src_doc) and records the
-- chunk that states it (src_chunk). The projection by_dst gives the incoming
-- relations of a document. A lightweight DELETE rebuilds the projection.
CREATE TABLE IF NOT EXISTS relations
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
    PROJECTION by_dst (SELECT * ORDER BY org_id, workspace_id, dst_doc),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
ORDER BY (org_id, workspace_id, src_doc, src_chunk, predicate, dst_doc)
SETTINGS
    enable_block_number_column = 1,
    enable_block_offset_column = 1,
    lightweight_mutation_projection_mode = 'rebuild';

-- RESTRICTIVE: a permissive policy that is added later cannot show rows of
-- another org. TO ALL: the policy applies to each user, also a user that is
-- added later. A row policy filters reads only. It does not apply to INSERT,
-- UPDATE or DELETE.
CREATE ROW POLICY OR REPLACE knowledge_org_wall ON documents AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON chunks AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON relations AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;
