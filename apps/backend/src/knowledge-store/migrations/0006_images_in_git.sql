-- The image columns after CTX-1412 (ADR-066 decision 6).
--
-- The alt text of an image reference goes on its relation. The file that
-- shows an image states an EMBEDS_IMAGE relation to the path of the image,
-- with the alt text. Two files can give one image different alt texts, so
-- the alt text is not on the image document. Each other relation has an
-- empty alt text. relations_in holds the same rows as relations, so it gets
-- the same column.
--
-- The bytes of an image stay in the Workspace Git, and the key of an image
-- is its path. Nothing writes s3_key, so the column goes.
--
-- Each statement is idempotent: a second run changes nothing.

ALTER TABLE relations ADD COLUMN IF NOT EXISTS alt_text String DEFAULT '' AFTER source;

ALTER TABLE relations_in ADD COLUMN IF NOT EXISTS alt_text String DEFAULT '' AFTER source;

ALTER TABLE documents DROP COLUMN IF EXISTS s3_key;
