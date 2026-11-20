-- The reading of each image by the vision model (CTX-1433, ADR-068 decision
-- 6). The projection converts an image to text at projection time and
-- stores no text in Git. A vision call costs money and its answer can
-- change, so the reading is kept here by the blob SHA of the image, the
-- vision model of the request (MODEL_VISION_NAME) and the prompt version. A rebuild reads it again and
-- makes no vision call: the same bytes give the same text.
--
-- reading is the JSON of the structured reading; the projection renders
-- the text (and the Mermaid) from it.
--
-- image_texts has the same CHECK constraint and the same row policy as the
-- other knowledge tables (see 0001_knowledge_tables.sql).
--
-- Each statement is idempotent: a second run after a failure changes nothing.

CREATE TABLE IF NOT EXISTS image_texts
(
    org_id String,
    workspace_id String,
    blob_sha String,
    model LowCardinality(String),
    prompt_version UInt32,
    reading String,
    created_at DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (org_id, workspace_id, blob_sha, model, prompt_version);

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON image_texts AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;
