ALTER TABLE "repositories" DROP CONSTRAINT IF EXISTS "repositories_slug_org_id_unique";--> statement-breakpoint
ALTER TABLE "repositories" DROP COLUMN IF EXISTS "slug";--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_name_org_id_unique" UNIQUE("name","org_id");
