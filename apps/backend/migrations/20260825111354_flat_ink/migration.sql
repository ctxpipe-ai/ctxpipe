ALTER TABLE "repositories" ADD COLUMN "repository_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_org_id_repository_key_uidx" ON "repositories" ("org_id","repository_key");