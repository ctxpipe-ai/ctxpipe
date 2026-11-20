-- The key of the vector of each chunk (CTX-1428): the SHA-256 of the model,
-- the dimensions and the content that the embedding request sends. A full
-- rebuild reuses the stored vector of a key, so it embeds only new content
-- (ADR-067 decision 5). An empty key is never reused: the rows from before
-- this migration get a new vector at their next write.
--
-- The statement is idempotent: a second run changes nothing.

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_key String DEFAULT '' AFTER embedding;
