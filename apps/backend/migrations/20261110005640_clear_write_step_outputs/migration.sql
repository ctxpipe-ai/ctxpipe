-- The clear of the retired write step outputs (CTX-1236) does not run here:
-- in production it took more than 9 minutes in the one transaction of the
-- deploy, and each deploy ran it again. Migrate runs it after Drizzle, in
-- batches that each commit (src/db/clear-retired-write-step-outputs.ts).
-- LangGraph was removed in CTX-601. No code reads these tables. A database
-- without them passes.
DROP TABLE IF EXISTS "public"."checkpoint_writes";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."checkpoint_blobs";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."checkpoints";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."checkpoint_migrations";
