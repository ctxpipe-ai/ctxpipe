-- Unified `connections` table: backfill from legacy installation tables, rewire FKs, drop legacy.
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "connections_org_id_idx" ON "connections" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "connections_org_id_type_idx" ON "connections" USING btree ("org_id","type");
--> statement-breakpoint

INSERT INTO "connections" ("id", "org_id", "type", "config", "created_at", "updated_at")
SELECT
	'con_' || split_part("id", '_', 2),
	"org_id",
	'github',
	jsonb_build_object(
		'installationId', "installation_id",
		'ingestAllRepositories', "ingest_all_repositories",
		'includeFutureRepos', "include_future_repos"
	),
	"created_at",
	"updated_at"
FROM "github_installations";
--> statement-breakpoint

INSERT INTO "connections" ("id", "org_id", "type", "config", "created_at", "updated_at")
SELECT
	'con_' || split_part("id", '_', 2),
	"org_id",
	'forge',
	jsonb_build_object(
		'cloudId', "cloud_id",
		'installationContext', "installation_context",
		'installationId', "installation_id",
		'appId', "app_id",
		'appSystemToken', "app_system_token",
		'atlassianApiBaseUrl', "atlassian_api_base_url",
		'installedByUserId', "installed_by_user_id",
		'status', "status",
		'lastEventPayload', "last_event_payload"
	),
	"created_at",
	"updated_at"
FROM "forge_installations";
--> statement-breakpoint

ALTER TABLE "repositories" ADD COLUMN "github_connection_id" text;
--> statement-breakpoint
UPDATE "repositories" SET "github_connection_id" = 'con_' || split_part("github_installation_id", '_', 2) WHERE "github_installation_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_EVGqN6DVQ2Er_fkey";
--> statement-breakpoint
ALTER TABLE "repositories" DROP COLUMN "github_installation_id";
--> statement-breakpoint
CREATE INDEX "repositories_github_connection_id_idx" ON "repositories" USING btree ("github_connection_id");
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_github_connection_id_connections_id_fk" FOREIGN KEY ("github_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "confluence_spaces" ADD COLUMN "connection_id" text;
--> statement-breakpoint
UPDATE "confluence_spaces" SET "connection_id" = 'con_' || split_part("forge_installation_id", '_', 2);
--> statement-breakpoint
ALTER TABLE "confluence_spaces" DROP CONSTRAINT "confluence_spaces_forge_installation_space_key_uq";
--> statement-breakpoint
ALTER TABLE "confluence_spaces" DROP CONSTRAINT "confluence_spaces_GkiKXFO3wg9l_fkey";
--> statement-breakpoint
ALTER TABLE "confluence_spaces" DROP COLUMN "forge_installation_id";
--> statement-breakpoint
ALTER TABLE "confluence_spaces" ALTER COLUMN "connection_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "confluence_spaces" ADD CONSTRAINT "confluence_spaces_connection_space_key_uq" UNIQUE("connection_id","space_key");
--> statement-breakpoint
ALTER TABLE "confluence_spaces" ADD CONSTRAINT "confluence_spaces_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "confluence_sync_targets" ADD COLUMN "connection_id" text;
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ADD COLUMN "repository_id" text;
--> statement-breakpoint
UPDATE "confluence_sync_targets" AS cst SET "connection_id" = 'con_' || split_part(cst."forge_installation_id", '_', 2);
--> statement-breakpoint
UPDATE "confluence_sync_targets" AS cst
SET "repository_id" = r."id"
FROM "repositories" AS r
WHERE r."org_id" = cst."org_id" AND r."name" = cst."repository_name";
--> statement-breakpoint
DROP INDEX IF EXISTS "confluence_sync_targets_org_id_uq";
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" DROP CONSTRAINT "confluence_sync_targets_jHlqwgXotiCq_fkey";
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" DROP COLUMN "forge_installation_id";
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" DROP COLUMN "repository_name";
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ALTER COLUMN "connection_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ALTER COLUMN "repository_id" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "confluence_sync_targets_connection_id_uq" ON "confluence_sync_targets" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX "confluence_sync_targets_repository_id_idx" ON "confluence_sync_targets" USING btree ("repository_id");
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ADD CONSTRAINT "confluence_sync_targets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ADD CONSTRAINT "confluence_sync_targets_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint

DROP TABLE "github_installations" CASCADE;
--> statement-breakpoint
DROP TABLE "forge_installations" CASCADE;
