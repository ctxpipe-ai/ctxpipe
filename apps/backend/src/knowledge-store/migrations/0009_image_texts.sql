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
