-- The times of a document (CTX-1710): createdAt (when the item began in
-- its source), updatedAt (when its content last changed in its source) and
-- expiresAt (the author's hint that the content is stale after a time).
--
-- On a file version, the columns hold the times that the file states
-- (documentTimes): they depend only on the file (ADR-071 decision 2). On a
-- tree row, they hold the times that an agent sees: the times of the file
-- version, with the Git times of the path on the branch where the file
-- states none (withGitTimes). The updatedAfter filter of a search uses
-- trees.updated_at.
--
-- A document has no valid window. The code does not read or write
-- valid_from and valid_to of documents and trees any more. The columns stay,
-- because the previous release reads them (ADR-053). The projection version
-- 12 rebuilds each Workspace on its next run, and this fills the new
-- columns.
--
-- Each statement is idempotent: a second run changes nothing.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_at Nullable(DateTime64(3, 'UTC')) AFTER mime;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at Nullable(DateTime64(3, 'UTC')) AFTER created_at;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS expires_at Nullable(DateTime64(3, 'UTC')) AFTER updated_at;

ALTER TABLE trees ADD COLUMN IF NOT EXISTS created_at Nullable(DateTime64(3, 'UTC')) AFTER observed_at;

ALTER TABLE trees ADD COLUMN IF NOT EXISTS updated_at Nullable(DateTime64(3, 'UTC')) AFTER created_at;

ALTER TABLE trees ADD COLUMN IF NOT EXISTS expires_at Nullable(DateTime64(3, 'UTC')) AFTER updated_at;
