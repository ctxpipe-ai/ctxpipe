CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"predicate" text NOT NULL,
	"object_id" text NOT NULL,
	"status" text NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"aggregated_confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_evidence" (
	"id" text PRIMARY KEY,
	"claim_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text,
	"extraction_method" text NOT NULL,
	"confidence" real NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"provenance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retrieval_objects" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retrieval_embeddings" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"object_id" text NOT NULL,
	"embedding" vector(4096) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retrieval_search" (
	"object_id" text PRIMARY KEY,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "claims_org_id_index" ON "claims" ("org_id");--> statement-breakpoint
CREATE INDEX "claims_subject_id_index" ON "claims" ("subject_id");--> statement-breakpoint
CREATE INDEX "claims_object_id_index" ON "claims" ("object_id");--> statement-breakpoint
CREATE INDEX "claims_status_index" ON "claims" ("status");--> statement-breakpoint
CREATE INDEX "claim_evidence_claim_id_index" ON "claim_evidence" ("claim_id");--> statement-breakpoint
CREATE INDEX "retrieval_objects_org_id_index" ON "retrieval_objects" ("org_id");--> statement-breakpoint
CREATE INDEX "retrieval_objects_type_index" ON "retrieval_objects" ("type");--> statement-breakpoint
CREATE INDEX "retrieval_objects_org_id_type_index" ON "retrieval_objects" ("org_id","type");--> statement-breakpoint
CREATE INDEX "retrieval_embeddings_org_id_index" ON "retrieval_embeddings" ("org_id");--> statement-breakpoint
CREATE INDEX "retrieval_embeddings_object_id_index" ON "retrieval_embeddings" ("object_id");--> statement-breakpoint
CREATE INDEX "retrieval_embeddings_embedding_idx" ON "retrieval_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "retrieval_search_content_index" ON "retrieval_search" ("content");--> statement-breakpoint
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_claims_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id");--> statement-breakpoint
ALTER TABLE "retrieval_embeddings" ADD CONSTRAINT "retrieval_embeddings_object_id_retrieval_objects_id_fkey" FOREIGN KEY ("object_id") REFERENCES "retrieval_objects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "retrieval_search" ADD CONSTRAINT "retrieval_search_object_id_retrieval_objects_id_fkey" FOREIGN KEY ("object_id") REFERENCES "retrieval_objects"("id") ON DELETE CASCADE;