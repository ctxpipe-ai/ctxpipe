-- LangGraph is removed. Nothing reads or writes these checkpoint tables.
DROP TABLE IF EXISTS "checkpoint_writes";--> statement-breakpoint
DROP TABLE IF EXISTS "checkpoint_blobs";--> statement-breakpoint
DROP TABLE IF EXISTS "checkpoints";--> statement-breakpoint
DROP TABLE IF EXISTS "checkpoint_migrations";
