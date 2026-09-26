-- Move-only TTL for the large Langfuse tables. No DELETE.
-- Run as a user with ALTER on database langfuse (the langfuse user).
-- Deploy config.d/ttl.xml first so this only rewrites ttl.txt.
--
-- Live tables (user langfuse): traces.timestamp DateTime64(3),
-- observations.start_time DateTime64(3), scores.timestamp DateTime64(3).
-- None of them had a TTL. Langfuse v3 ClickHouse migrations create these
-- with CREATE TABLE IF NOT EXISTS and do not set a TTL on them. The 7-day
-- and 30-day TTLs upstream were on aggregating tables (traces_7d_amt,
-- traces_30d_amt) that migration 0029 dropped.
-- A later migration that recreates one of these tables drops this rule;
-- the rows stay hot, which is the previous behavior, and nothing is deleted.
--
-- Partitions are monthly, so a part moves once its rows are past 30 days
-- (about one to two months on the volume). Cold parts are not merged
-- (prefer_not_to_merge), so ReplacingMergeTree versions stay until Langfuse
-- reads them with FINAL.

ALTER TABLE langfuse.traces
    MODIFY TTL toDateTime(timestamp) + INTERVAL 30 DAY TO VOLUME 'cold';

ALTER TABLE langfuse.observations
    MODIFY TTL toDateTime(start_time) + INTERVAL 30 DAY TO VOLUME 'cold';

ALTER TABLE langfuse.scores
    MODIFY TTL toDateTime(timestamp) + INTERVAL 30 DAY TO VOLUME 'cold';
