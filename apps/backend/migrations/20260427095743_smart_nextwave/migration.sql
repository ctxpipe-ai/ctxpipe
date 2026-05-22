-- Unified connections backfill (from legacy install tables) + schema alignment + pending_accounts.
-- Idempotent for DBs that already applied prior AI migrations (unified_connections) or partial steps.

-- Connections table (structure matches Drizzle schema)
CREATE TABLE IF NOT EXISTS "connections" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'connections_org_id_organizations_id_fkey'
  ) THEN
    ALTER TABLE "connections" ADD CONSTRAINT "connections_org_id_organizations_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_org_id_idx" ON "connections" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connections_org_id_type_idx" ON "connections" ("org_id","type");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'github_installations') THEN
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
    FROM "github_installations"
    ON CONFLICT ("id") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'forge_installations') THEN
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
    FROM "forge_installations"
    ON CONFLICT ("id") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
-- Repositories: migrate github_installation_id -> github_connection_id (legacy path) or no-op
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'repositories' AND column_name = 'github_installation_id'
  ) THEN
    ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "github_connection_id" text;
    UPDATE "repositories" SET "github_connection_id" = 'con_' || split_part("github_installation_id", '_', 2) WHERE "github_installation_id" IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT IF EXISTS "repositories_EVGqN6DVQ2Er_fkey";
--> statement-breakpoint
ALTER TABLE "repositories" DROP COLUMN IF EXISTS "github_installation_id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repositories_github_connection_id_idx" ON "repositories" USING btree ("github_connection_id");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repositories_github_connection_id_connections_id_fk') THEN
    ALTER TABLE "repositories" DROP CONSTRAINT "repositories_github_connection_id_connections_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repositories_github_connection_id_connections_id_fkey') THEN
    ALTER TABLE "repositories" ADD CONSTRAINT "repositories_github_connection_id_connections_id_fkey"
      FOREIGN KEY ("github_connection_id") REFERENCES "public"."connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
-- Confluence spaces: legacy -> connection_id
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'confluence_spaces' AND column_name = 'forge_installation_id'
  ) THEN
    ALTER TABLE "confluence_spaces" ADD COLUMN IF NOT EXISTS "connection_id" text;
    UPDATE "confluence_spaces" SET "connection_id" = 'con_' || split_part("forge_installation_id", '_', 2) WHERE "forge_installation_id" IS NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "confluence_spaces" DROP CONSTRAINT IF EXISTS "confluence_spaces_forge_installation_space_key_uq";
--> statement-breakpoint
ALTER TABLE "confluence_spaces" DROP CONSTRAINT IF EXISTS "confluence_spaces_GkiKXFO3wg9l_fkey";
--> statement-breakpoint
ALTER TABLE "confluence_spaces" DROP COLUMN IF EXISTS "forge_installation_id";
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'confluence_spaces' AND column_name = 'connection_id' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "confluence_spaces" ALTER COLUMN "connection_id" SET NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'confluence_spaces_connection_space_key_uq'
  ) THEN
    ALTER TABLE "confluence_spaces" ADD CONSTRAINT "confluence_spaces_connection_space_key_uq" UNIQUE("connection_id","space_key");
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'confluence_spaces_connection_id_connections_id_fk') THEN
    ALTER TABLE "confluence_spaces" DROP CONSTRAINT "confluence_spaces_connection_id_connections_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'confluence_spaces_connection_id_connections_id_fkey') THEN
    ALTER TABLE "confluence_spaces" ADD CONSTRAINT "confluence_spaces_connection_id_connections_id_fkey"
      FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "confluence_spaces_connection_id_index" ON "confluence_spaces" ("connection_id");
--> statement-breakpoint
-- Confluence sync targets: add columns, rewire, drop legacy
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'confluence_sync_targets' AND column_name = 'forge_installation_id'
  ) THEN
    ALTER TABLE "confluence_sync_targets" ADD COLUMN IF NOT EXISTS "connection_id" text;
    ALTER TABLE "confluence_sync_targets" ADD COLUMN IF NOT EXISTS "repository_id" text;
    UPDATE "confluence_sync_targets" AS cst SET "connection_id" = 'con_' || split_part(cst."forge_installation_id", '_', 2);
    UPDATE "confluence_sync_targets" AS cst
    SET "repository_id" = r."id"
    FROM "repositories" AS r
    WHERE r."org_id" = cst."org_id" AND r."name" = cst."repository_name";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" DROP CONSTRAINT IF EXISTS "confluence_sync_targets_jHlqwgXotiCq_fkey";
--> statement-breakpoint
DROP INDEX IF EXISTS "confluence_sync_targets_org_id_uq";
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" DROP COLUMN IF EXISTS "forge_installation_id";
--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" DROP COLUMN IF EXISTS "repository_name";
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'confluence_sync_targets' AND column_name = 'connection_id' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "confluence_sync_targets" ALTER COLUMN "connection_id" SET NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'confluence_sync_targets' AND column_name = 'repository_id' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE "confluence_sync_targets" ALTER COLUMN "repository_id" SET NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "confluence_sync_targets_connection_id_uq" ON "confluence_sync_targets" ("connection_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "confluence_sync_targets_repository_id_idx" ON "confluence_sync_targets" ("repository_id");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'confluence_sync_targets_connection_id_connections_id_fk') THEN
    ALTER TABLE "confluence_sync_targets" DROP CONSTRAINT "confluence_sync_targets_connection_id_connections_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'confluence_sync_targets_connection_id_connections_id_fkey') THEN
    ALTER TABLE "confluence_sync_targets" ADD CONSTRAINT "confluence_sync_targets_connection_id_connections_id_fkey"
      FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'confluence_sync_targets_repository_id_repositories_id_fk') THEN
    ALTER TABLE "confluence_sync_targets" DROP CONSTRAINT "confluence_sync_targets_repository_id_repositories_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'confluence_sync_targets_repository_id_repositories_id_fkey') THEN
    ALTER TABLE "confluence_sync_targets" ADD CONSTRAINT "confluence_sync_targets_repository_id_repositories_id_fkey"
      FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "confluence_sync_targets_forge_installation_id_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "confluence_spaces_forge_installation_id_index";
--> statement-breakpoint
DROP TABLE IF EXISTS "github_installations" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "forge_installations" CASCADE;
--> statement-breakpoint
-- pending_accounts (Drizzle schema)
CREATE TABLE IF NOT EXISTS "pending_accounts" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"conflicting_account_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_accounts_userId_idx" ON "pending_accounts" ("user_id");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_accounts_user_id_users_id_fk') THEN
    ALTER TABLE "pending_accounts" DROP CONSTRAINT "pending_accounts_user_id_users_id_fk";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_accounts_user_id_users_id_fkey') THEN
    ALTER TABLE "pending_accounts" ADD CONSTRAINT "pending_accounts_user_id_users_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
