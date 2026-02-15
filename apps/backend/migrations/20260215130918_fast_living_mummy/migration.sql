ALTER TABLE "repositories" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_git_url_org_id_unique" UNIQUE("git_url","org_id");