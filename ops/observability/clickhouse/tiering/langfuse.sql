-- Langfuse migrations run on every langfuse-web and langfuse-worker boot
-- and own the CREATE/ALTER statements for these tables. This file does
-- not MODIFY TTL and does not rename the storage policy.
--
-- config.d/storage.xml redefines policy default (local disk, then cold).
-- Langfuse MergeTree tables already use that policy name, and a migration
-- that creates a new MergeTree without SETTINGS storage_policy picks it
-- up too. Parts move to cold only when the hot filesystem crosses
-- move_factor. Nothing in this tiering deletes Langfuse rows.
--
-- Review output: every MergeTree in langfuse should show storage_policy
-- default after the new ClickHouse config is up.

SELECT database, name, engine, storage_policy
FROM system.tables
WHERE database = 'langfuse' AND engine LIKE '%MergeTree%'
ORDER BY name;
