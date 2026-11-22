-- The source's own time of a file version (CTX-1516): for example the
-- createdAt of a mirrored issue, or the date of a design record. It depends
-- only on the file, so it is on the file version (ADR-071 decision 2). The
-- tree row takes valid_from from it, else from the commit that introduced
-- the file on the branch. Null when the file states no time. The column
-- only adds (ADR-053), so the rows stay as they are.
--
-- The statement is idempotent: a second run changes nothing.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS valid_from Nullable(DateTime64(3, 'UTC')) AFTER mime;
