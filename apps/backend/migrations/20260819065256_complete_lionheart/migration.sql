UPDATE "connections" AS c
SET "config" = c."config" || jsonb_build_object(
  'repositoryId', t."repository_id",
  'branch', t."branch",
  'enabled', t."enabled"
),
"updated_at" = now()
FROM "slack_sync_targets" AS t
WHERE c."id" = t."connection_id" AND c."type" = 'slack';--> statement-breakpoint
DROP TABLE "slack_sync_targets";
