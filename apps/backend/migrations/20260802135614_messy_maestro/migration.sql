ALTER TABLE "repositories" ADD COLUMN "indexing_step" integer;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "indexing_step_total" integer;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "indexing_step_key" text;