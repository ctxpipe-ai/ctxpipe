CREATE TYPE "repository_indexing_status" AS ENUM('queued', 'running', 'ready', 'failed');--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "indexing_status" "repository_indexing_status";--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "indexing_error" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "indexing_failed_at" timestamp with time zone;