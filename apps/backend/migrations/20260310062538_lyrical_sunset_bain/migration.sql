ALTER TABLE "retrieval_objects" ADD COLUMN "deduplication_key" text;--> statement-breakpoint
ALTER TABLE "retrieval_embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(2000) USING "embedding"::vector(2000);--> statement-breakpoint
CREATE INDEX "retrieval_objects_org_id_deduplication_key_index" ON "retrieval_objects" ("org_id","deduplication_key");