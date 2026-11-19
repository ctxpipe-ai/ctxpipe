-- The reference keys of each document (ADR-066 decisions 3 and 5,
-- CTX-1400). A file states its own keys, for example the Linear identifier
-- of a Linear mirror file. A relation of another file can target a key
-- (`dst_doc` = 'ref:' || ref_key), and the read finds the documents of the
-- key here. KnowledgeStore writes and deletes the rows of a document
-- together with its other rows.
--
-- doc_refs has the same CHECK constraint and the same row policy as the
-- other knowledge tables (see 0001_knowledge_tables.sql).
--
-- Each statement is idempotent: a second run after a failure changes nothing.

CREATE TABLE IF NOT EXISTS doc_refs
(
    org_id String,
    workspace_id String,
    ref_key String,
    doc_key String,
    CONSTRAINT org_wall CHECK org_id = getSetting('SQL_ctxpipe_org_id')
)
ENGINE = MergeTree
ORDER BY (org_id, workspace_id, ref_key, doc_key);

CREATE ROW POLICY OR REPLACE knowledge_org_wall ON doc_refs AS RESTRICTIVE
    USING org_id = getSetting('SQL_ctxpipe_org_id') TO ALL;
