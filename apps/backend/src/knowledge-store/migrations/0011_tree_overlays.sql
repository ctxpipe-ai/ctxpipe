-- The overlays of the branches other than the default branch (ADR-071
-- decisions 3 and 5, CTX-1457).
-- * kind `inherit`: an overlay row that takes the path out of the overlay
--   again, so the view of the branch shows the row of the default branch.
-- * blob_sha: the blob of the file version of the row, so that read_file
--   reads the file of the view from the Workspace Git. The projection
--   version increases with this file, so each tree gets the column.
--
-- Each statement is idempotent: a second run changes nothing.

ALTER TABLE trees MODIFY COLUMN kind Enum8('file' = 1, 'deleted' = 2, 'inherit' = 3);

ALTER TABLE trees ADD COLUMN IF NOT EXISTS blob_sha String DEFAULT '' AFTER version;
