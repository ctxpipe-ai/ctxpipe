-- The overlays of the branches other than the default branch (ADR-071
-- decisions 3 and 5, CTX-1457). The kind `inherit` is an overlay row that
-- takes the path out of the overlay again, so the view of the branch shows
-- the row of the default branch. The enum only gets a value, so the rows
-- stay as they are.
--
-- The statement is idempotent: a second run changes nothing.

ALTER TABLE trees MODIFY COLUMN kind Enum8('file' = 1, 'deleted' = 2, 'inherit' = 3);
