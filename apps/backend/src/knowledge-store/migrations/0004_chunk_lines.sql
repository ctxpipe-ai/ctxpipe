-- The file lines of each chunk (CTX-1406). A search hit gives the lines of
-- its chunk, so that the agent can read that part of the file (ADR-051
-- section 5). The lines are 1-based and inclusive. 0 means that the chunk
-- has no lines in a text file, for example the chunk of an image.
--
-- Each statement is idempotent: a second run changes nothing.

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS start_line UInt32 DEFAULT 0 AFTER text;

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS end_line UInt32 DEFAULT 0 AFTER start_line;
