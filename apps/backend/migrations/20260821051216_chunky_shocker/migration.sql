CREATE TABLE "connection_directory" (
	"connection_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"github_installation_id" text,
	"slack_team_id" text,
	"linear_workspace_id" text,
	"notion_workspace_id" text,
	"notion_bot_id" text,
	"forge_cloud_id" text,
	"forge_installation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "connection_directory" (
	"connection_id",
	"org_id",
	"type",
	"github_installation_id",
	"slack_team_id",
	"linear_workspace_id",
	"notion_workspace_id",
	"notion_bot_id",
	"forge_cloud_id",
	"forge_installation_id",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"org_id",
	"type",
	CASE WHEN "type" = 'github' THEN NULLIF("config"->>'installationId', '') END,
	CASE WHEN "type" = 'slack' THEN NULLIF("config"->>'teamId', '') END,
	CASE WHEN "type" = 'linear' THEN NULLIF("config"->>'workspaceId', '') END,
	CASE WHEN "type" = 'notion' THEN NULLIF("config"->>'workspaceId', '') END,
	CASE WHEN "type" = 'notion' THEN NULLIF("config"->>'botId', '') END,
	CASE WHEN "type" = 'forge' THEN NULLIF("config"->>'cloudId', '') END,
	CASE WHEN "type" = 'forge' THEN NULLIF("config"->>'installationId', '') END,
	"created_at",
	"updated_at"
FROM "connections";
--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "confluence_spaces" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "repository_checkouts" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "workspace_write_jobs" ADD COLUMN "org_id" text;--> statement-breakpoint
UPDATE "claim_evidence" AS e SET "org_id" = c."org_id" FROM "claims" AS c WHERE e."claim_id" = c."id" AND e."org_id" IS NULL;--> statement-breakpoint
UPDATE "confluence_spaces" AS s SET "org_id" = c."org_id" FROM "connections" AS c WHERE s."connection_id" = c."id" AND s."org_id" IS NULL;--> statement-breakpoint
UPDATE "repository_checkouts" AS ch SET "org_id" = r."org_id" FROM "repositories" AS r WHERE ch."repository_id" = r."id" AND ch."org_id" IS NULL;--> statement-breakpoint
UPDATE "workspace_write_jobs" AS j SET "org_id" = w."org_id" FROM "workspaces" AS w WHERE j."workspace_id" = w."id" AND j."org_id" IS NULL;--> statement-breakpoint
UPDATE "workspace_sandbox_instances" AS s SET "org_id" = w."org_id" FROM "workspaces" AS w WHERE s."workspace_id" = w."id" AND s."org_id" IS NULL;--> statement-breakpoint
-- Expand-only: "claim_evidence", "confluence_spaces" and "repository_checkouts"
-- keep a nullable "org_id" in this minor release, so that the previous image can still
-- write rows after a rollback. RLS hides rows with no org from the app role. The next
-- major release sets NOT NULL. The DELETE of orphan rows runs in the migration
-- transaction, so a failed migration deletes nothing.
DELETE FROM "claim_evidence" WHERE "org_id" IS NULL;--> statement-breakpoint
DELETE FROM "confluence_spaces" WHERE "org_id" IS NULL;--> statement-breakpoint
DELETE FROM "repository_checkouts" WHERE "org_id" IS NULL;--> statement-breakpoint
DELETE FROM "workspace_write_jobs" WHERE "org_id" IS NULL;--> statement-breakpoint
DELETE FROM "workspace_sandbox_instances" WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_write_jobs" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "confluence_spaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_onboarding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repository_checkouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_member_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_write_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "claim_evidence_org_id_idx" ON "claim_evidence" ("org_id");--> statement-breakpoint
CREATE INDEX "confluence_spaces_org_id_idx" ON "confluence_spaces" ("org_id");--> statement-breakpoint
CREATE INDEX "connection_directory_org_id_idx" ON "connection_directory" ("org_id");--> statement-breakpoint
CREATE INDEX "connection_directory_github_installation_id_idx" ON "connection_directory" ("github_installation_id");--> statement-breakpoint
CREATE INDEX "connection_directory_slack_team_id_idx" ON "connection_directory" ("slack_team_id");--> statement-breakpoint
CREATE INDEX "connection_directory_linear_workspace_id_idx" ON "connection_directory" ("linear_workspace_id");--> statement-breakpoint
CREATE INDEX "connection_directory_notion_workspace_id_idx" ON "connection_directory" ("notion_workspace_id");--> statement-breakpoint
CREATE INDEX "connection_directory_notion_bot_id_idx" ON "connection_directory" ("notion_bot_id");--> statement-breakpoint
CREATE INDEX "connection_directory_forge_cloud_id_idx" ON "connection_directory" ("forge_cloud_id");--> statement-breakpoint
CREATE INDEX "connection_directory_forge_installation_id_idx" ON "connection_directory" ("forge_installation_id");--> statement-breakpoint
CREATE INDEX "repository_checkouts_org_id_idx" ON "repository_checkouts" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_sandbox_instances_org_id_idx" ON "workspace_sandbox_instances" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_write_jobs_org_id_idx" ON "workspace_write_jobs" ("org_id");--> statement-breakpoint
CREATE POLICY "org_isolation" ON "claim_evidence" AS PERMISSIVE FOR ALL TO public USING ("claim_evidence"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("claim_evidence"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "claims" AS PERMISSIVE FOR ALL TO public USING ("claims"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("claims"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "confluence_spaces" AS PERMISSIVE FOR ALL TO public USING ("confluence_spaces"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("confluence_spaces"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "confluence_sync_targets" AS PERMISSIVE FOR ALL TO public USING ("confluence_sync_targets"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("confluence_sync_targets"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "connections" AS PERMISSIVE FOR ALL TO public USING ("connections"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("connections"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "conversation_messages" AS PERMISSIVE FOR ALL TO public USING ("conversation_messages"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("conversation_messages"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "conversations" AS PERMISSIVE FOR ALL TO public USING ("conversations"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("conversations"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "objects" AS PERMISSIVE FOR ALL TO public USING ("objects"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("objects"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_onboarding" AS PERMISSIVE FOR ALL TO public USING ("org_onboarding"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("org_onboarding"."organization_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "repositories" AS PERMISSIVE FOR ALL TO public USING ("repositories"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("repositories"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "repository_checkouts" AS PERMISSIVE FOR ALL TO public USING ("repository_checkouts"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("repository_checkouts"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_member_preferences" AS PERMISSIVE FOR ALL TO public USING ("org_member_preferences"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("org_member_preferences"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_knowledge_units" AS PERMISSIVE FOR ALL TO public USING ("workspace_knowledge_units"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_knowledge_units"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_sandbox_instances" AS PERMISSIVE FOR ALL TO public USING ("workspace_sandbox_instances"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_sandbox_instances"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_write_jobs" AS PERMISSIVE FOR ALL TO public USING ("workspace_write_jobs"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_write_jobs"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspaces" AS PERMISSIVE FOR ALL TO public USING ("workspaces"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspaces"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
-- Expand-only: after a rollback, the previous image writes these rows with no
-- "org_id". These BEFORE INSERT triggers copy "org_id" from the parent row, so that
-- the app role can see the rows after the next upgrade. The functions run with the
-- rights of the caller, so RLS on the parent table applies to the app role. The next
-- major release sets NOT NULL and drops these triggers.
CREATE FUNCTION "claim_evidence_fill_org_id"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."org_id" IS NULL THEN
		NEW."org_id" := (SELECT c."org_id" FROM "public"."claims" AS c WHERE c."id" = NEW."claim_id");
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "claim_evidence_fill_org_id" BEFORE INSERT ON "claim_evidence" FOR EACH ROW EXECUTE FUNCTION "claim_evidence_fill_org_id"();--> statement-breakpoint
CREATE FUNCTION "confluence_spaces_fill_org_id"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."org_id" IS NULL THEN
		NEW."org_id" := (SELECT c."org_id" FROM "public"."connections" AS c WHERE c."id" = NEW."connection_id");
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "confluence_spaces_fill_org_id" BEFORE INSERT ON "confluence_spaces" FOR EACH ROW EXECUTE FUNCTION "confluence_spaces_fill_org_id"();--> statement-breakpoint
CREATE FUNCTION "repository_checkouts_fill_org_id"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."org_id" IS NULL THEN
		NEW."org_id" := (SELECT r."org_id" FROM "public"."repositories" AS r WHERE r."id" = NEW."repository_id");
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "repository_checkouts_fill_org_id" BEFORE INSERT ON "repository_checkouts" FOR EACH ROW EXECUTE FUNCTION "repository_checkouts_fill_org_id"();
