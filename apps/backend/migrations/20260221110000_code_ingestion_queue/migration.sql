ALTER TABLE "repositories" ADD COLUMN "last_ingested_hash" text;

CREATE TABLE "repository_ingestion_queue" (
  "id" text PRIMARY KEY,
  "repository_id" text NOT NULL,
  "org_id" text NOT NULL,
  "target_hash" text NOT NULL,
  "source_branch" text,
  "from_hash" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repository_ingestion_queue_status_check"
    CHECK ("status" IN ('pending', 'processing'))
);

CREATE INDEX "repository_ingestion_queue_status_available_at_created_at_index"
  ON "repository_ingestion_queue" ("status","available_at","created_at");
CREATE INDEX "repository_ingestion_queue_repository_id_created_at_index"
  ON "repository_ingestion_queue" ("repository_id","created_at");

CREATE TABLE "repository_ingestion_errors" (
  "id" text PRIMARY KEY,
  "queue_job_id" text,
  "repository_id" text NOT NULL,
  "org_id" text NOT NULL,
  "target_hash" text NOT NULL,
  "source_branch" text,
  "from_hash" text,
  "attempt_count" integer NOT NULL,
  "error_message" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
