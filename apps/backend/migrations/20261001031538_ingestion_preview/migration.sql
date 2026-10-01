CREATE TABLE "ingestion_preview_links" (
	"repository_id" text,
	"org_id" text NOT NULL,
	"source_key" text,
	"target_key" text,
	"predicate" text,
	CONSTRAINT "ingestion_preview_links_pkey" PRIMARY KEY("repository_id","source_key","target_key","predicate")
);
--> statement-breakpoint
CREATE TABLE "ingestion_preview_nodes" (
	"repository_id" text,
	"org_id" text NOT NULL,
	"node_key" text,
	"kind" text NOT NULL,
	"name" text,
	CONSTRAINT "ingestion_preview_nodes_pkey" PRIMARY KEY("repository_id","node_key")
);
--> statement-breakpoint
CREATE INDEX "ingestion_preview_links_org_id_index" ON "ingestion_preview_links" ("org_id");--> statement-breakpoint
CREATE INDEX "ingestion_preview_nodes_org_id_index" ON "ingestion_preview_nodes" ("org_id");--> statement-breakpoint
ALTER TABLE "ingestion_preview_links" ADD CONSTRAINT "ingestion_preview_links_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ingestion_preview_nodes" ADD CONSTRAINT "ingestion_preview_nodes_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;