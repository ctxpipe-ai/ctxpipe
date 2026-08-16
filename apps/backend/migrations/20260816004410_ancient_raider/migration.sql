ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_org_id_slug_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_id_slug_uidx" ON "workspaces" ("org_id",lower("slug"));