-- Step 0: bypass tenant RLS for backfill / DDL (transaction-local; drizzle migrator runs in a transaction).
select set_config('app.system_access', 'true', true);--> statement-breakpoint

-- Step 1: backfill org_id where it was introduced nullable.
update "repository_checkouts" rc
set "org_id" = r."org_id"
from "repositories" r
where rc."org_id" is null and rc."repository_id" = r."id";--> statement-breakpoint

update "claim_evidence" ce
set "org_id" = c."org_id"
from "claims" c
where ce."org_id" is null and ce."claim_id" = c."id";--> statement-breakpoint

-- Step 2: NOT NULL + FK to organizations (idempotent constraint names for re-runs).
alter table "repository_checkouts" alter column "org_id" set not null;--> statement-breakpoint
alter table "claim_evidence" alter column "org_id" set not null;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "claims" ADD CONSTRAINT "claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "forge_installations" ADD CONSTRAINT "forge_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "repositories" ADD CONSTRAINT "repositories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "repository_checkouts" ADD CONSTRAINT "repository_checkouts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "objects" ADD CONSTRAINT "objects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- Step 3: RLS + policies (after rows reference valid orgs).
-- Enable RLS after data is consistent.
ALTER TABLE "claim_evidence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "forge_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repository_checkouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_onboarding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- FORCE RLS so policies apply even to table owners (single-role setup).
ALTER TABLE "claim_evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claims" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_installations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "forge_installations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repositories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "repository_checkouts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "objects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_onboarding" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "claim_evidence_system_access_select" ON "claim_evidence" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "claim_evidence_tenant_select" ON "claim_evidence" AS PERMISSIVE FOR SELECT TO public USING (("claim_evidence"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "claim_evidence_system_access_insert" ON "claim_evidence" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "claim_evidence_tenant_insert" ON "claim_evidence" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("claim_evidence"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "claim_evidence_system_access_update" ON "claim_evidence" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'true') WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "claim_evidence_tenant_update" ON "claim_evidence" AS PERMISSIVE FOR UPDATE TO public USING (("claim_evidence"."org_id" = current_setting('app.organization_id', true))) WITH CHECK (("claim_evidence"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "claim_evidence_system_access_delete" ON "claim_evidence" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "claim_evidence_tenant_delete" ON "claim_evidence" AS PERMISSIVE FOR DELETE TO public USING (("claim_evidence"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "claims_system_access_select" ON "claims" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "claims_tenant_select" ON "claims" AS PERMISSIVE FOR SELECT TO public USING (("claims"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "claims_system_access_insert" ON "claims" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "claims_tenant_insert" ON "claims" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("claims"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "claims_system_access_update" ON "claims" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'true') WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "claims_tenant_update" ON "claims" AS PERMISSIVE FOR UPDATE TO public USING (("claims"."org_id" = current_setting('app.organization_id', true))) WITH CHECK (("claims"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "claims_system_access_delete" ON "claims" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "claims_tenant_delete" ON "claims" AS PERMISSIVE FOR DELETE TO public USING (("claims"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "github_installations_system_access_select" ON "github_installations" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "github_installations_tenant_select" ON "github_installations" AS PERMISSIVE FOR SELECT TO public USING (("github_installations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "github_installations_system_access_insert" ON "github_installations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "github_installations_tenant_insert" ON "github_installations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("github_installations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "github_installations_system_access_update" ON "github_installations" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'true') WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "github_installations_tenant_update" ON "github_installations" AS PERMISSIVE FOR UPDATE TO public USING (("github_installations"."org_id" = current_setting('app.organization_id', true))) WITH CHECK (("github_installations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "github_installations_system_access_delete" ON "github_installations" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "github_installations_tenant_delete" ON "github_installations" AS PERMISSIVE FOR DELETE TO public USING (("github_installations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "forge_installations_system_access_select" ON "forge_installations" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "forge_installations_tenant_select" ON "forge_installations" AS PERMISSIVE FOR SELECT TO public USING (("forge_installations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "forge_installations_system_access_insert" ON "forge_installations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "forge_installations_tenant_insert" ON "forge_installations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("forge_installations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "forge_installations_system_access_update" ON "forge_installations" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'true') WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "forge_installations_tenant_update" ON "forge_installations" AS PERMISSIVE FOR UPDATE TO public USING (("forge_installations"."org_id" = current_setting('app.organization_id', true))) WITH CHECK (("forge_installations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "forge_installations_system_access_delete" ON "forge_installations" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "forge_installations_tenant_delete" ON "forge_installations" AS PERMISSIVE FOR DELETE TO public USING (("forge_installations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "conversations_system_access_select" ON "conversations" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "conversations_tenant_select" ON "conversations" AS PERMISSIVE FOR SELECT TO public USING (("conversations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "conversations_system_access_insert" ON "conversations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "conversations_tenant_insert" ON "conversations" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("conversations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "conversations_system_access_update" ON "conversations" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'true') WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "conversations_tenant_update" ON "conversations" AS PERMISSIVE FOR UPDATE TO public USING (("conversations"."org_id" = current_setting('app.organization_id', true))) WITH CHECK (("conversations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "conversations_system_access_delete" ON "conversations" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "conversations_tenant_delete" ON "conversations" AS PERMISSIVE FOR DELETE TO public USING (("conversations"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "repositories_system_access_select" ON "repositories" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "repositories_tenant_select" ON "repositories" AS PERMISSIVE FOR SELECT TO public USING (("repositories"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "repositories_system_access_insert" ON "repositories" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "repositories_tenant_insert" ON "repositories" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("repositories"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "repositories_system_access_update" ON "repositories" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'true') WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "repositories_tenant_update" ON "repositories" AS PERMISSIVE FOR UPDATE TO public USING (("repositories"."org_id" = current_setting('app.organization_id', true))) WITH CHECK (("repositories"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "repositories_system_access_delete" ON "repositories" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "repositories_tenant_delete" ON "repositories" AS PERMISSIVE FOR DELETE TO public USING (("repositories"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "repository_checkouts_system_access_select" ON "repository_checkouts" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "repository_checkouts_tenant_select" ON "repository_checkouts" AS PERMISSIVE FOR SELECT TO public USING (("repository_checkouts"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "repository_checkouts_system_access_insert" ON "repository_checkouts" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "repository_checkouts_tenant_insert" ON "repository_checkouts" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("repository_checkouts"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "repository_checkouts_system_access_update" ON "repository_checkouts" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'true') WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "repository_checkouts_tenant_update" ON "repository_checkouts" AS PERMISSIVE FOR UPDATE TO public USING (("repository_checkouts"."org_id" = current_setting('app.organization_id', true))) WITH CHECK (("repository_checkouts"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "repository_checkouts_system_access_delete" ON "repository_checkouts" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "repository_checkouts_tenant_delete" ON "repository_checkouts" AS PERMISSIVE FOR DELETE TO public USING (("repository_checkouts"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "objects_system_access_select" ON "objects" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "objects_tenant_select" ON "objects" AS PERMISSIVE FOR SELECT TO public USING (("objects"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "objects_system_access_insert" ON "objects" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "objects_tenant_insert" ON "objects" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("objects"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "objects_system_access_update" ON "objects" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'true') WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "objects_tenant_update" ON "objects" AS PERMISSIVE FOR UPDATE TO public USING (("objects"."org_id" = current_setting('app.organization_id', true))) WITH CHECK (("objects"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "objects_system_access_delete" ON "objects" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "objects_tenant_delete" ON "objects" AS PERMISSIVE FOR DELETE TO public USING (("objects"."org_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "org_onboarding_system_access_select" ON "org_onboarding" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "org_onboarding_tenant_select" ON "org_onboarding" AS PERMISSIVE FOR SELECT TO public USING (("org_onboarding"."organization_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "org_onboarding_system_access_insert" ON "org_onboarding" AS PERMISSIVE FOR INSERT TO public WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "org_onboarding_tenant_insert" ON "org_onboarding" AS PERMISSIVE FOR INSERT TO public WITH CHECK (("org_onboarding"."organization_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "org_onboarding_system_access_update" ON "org_onboarding" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('app.system_access', true) = 'true') WITH CHECK (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "org_onboarding_tenant_update" ON "org_onboarding" AS PERMISSIVE FOR UPDATE TO public USING (("org_onboarding"."organization_id" = current_setting('app.organization_id', true))) WITH CHECK (("org_onboarding"."organization_id" = current_setting('app.organization_id', true)));--> statement-breakpoint
CREATE POLICY "org_onboarding_system_access_delete" ON "org_onboarding" AS PERMISSIVE FOR DELETE TO public USING (current_setting('app.system_access', true) = 'true');--> statement-breakpoint
CREATE POLICY "org_onboarding_tenant_delete" ON "org_onboarding" AS PERMISSIVE FOR DELETE TO public USING (("org_onboarding"."organization_id" = current_setting('app.organization_id', true)));