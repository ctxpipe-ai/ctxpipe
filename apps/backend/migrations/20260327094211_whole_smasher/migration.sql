-- Snapshot lag: repository_checkouts already exists (20260323115738_overjoyed_wraith); slim columns only.
ALTER TABLE "repository_checkouts" DROP COLUMN IF EXISTS "zoekt_index_fingerprint";--> statement-breakpoint
ALTER TABLE "repository_checkouts" DROP COLUMN IF EXISTS "cgc_index_fingerprint";--> statement-breakpoint
ALTER TABLE "repository_checkouts" DROP COLUMN IF EXISTS "index_fingerprint";--> statement-breakpoint
ALTER TABLE "repository_checkouts" DROP COLUMN IF EXISTS "zoekt_index_ready";--> statement-breakpoint
ALTER TABLE "repository_checkouts" DROP COLUMN IF EXISTS "cgc_index_ready";--> statement-breakpoint
ALTER TABLE "repository_checkouts" DROP COLUMN IF EXISTS "cgc_partial_json";--> statement-breakpoint
ALTER TABLE "repository_checkouts" DROP COLUMN IF EXISTS "last_accessed_at";--> statement-breakpoint
CREATE TABLE "objects" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"deduplication_key" text,
	"payload" jsonb NOT NULL,
	"embedding" vector(2000),
	"search_content" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retrieval_embeddings" DROP CONSTRAINT "retrieval_embeddings_object_id_retrieval_objects_id_fkey";--> statement-breakpoint
ALTER TABLE "retrieval_search" DROP CONSTRAINT "retrieval_search_object_id_retrieval_objects_id_fkey";--> statement-breakpoint
DROP TABLE "retrieval_embeddings";--> statement-breakpoint
DROP TABLE "retrieval_objects";--> statement-breakpoint
DROP TABLE "retrieval_search";--> statement-breakpoint
CREATE INDEX "objects_org_id_index" ON "objects" ("org_id");--> statement-breakpoint
CREATE INDEX "objects_kind_index" ON "objects" ("kind");--> statement-breakpoint
CREATE INDEX "objects_org_id_kind_index" ON "objects" ("org_id","kind");--> statement-breakpoint
CREATE INDEX "objects_org_id_deduplication_key_index" ON "objects" ("org_id","deduplication_key");--> statement-breakpoint
CREATE INDEX "retrieval_embeddings_embedding_idx" ON "objects" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "retrieval_search_content_fts_idx" ON "objects" USING gin (to_tsvector('english', "search_content"));
