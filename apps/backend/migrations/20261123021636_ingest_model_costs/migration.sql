CREATE TABLE "ingest_model_costs" (
	"org_id" text,
	"run_id" text,
	"shard" integer,
	"step" text,
	"cost_usd" double precision NOT NULL,
	CONSTRAINT "ingest_model_costs_pkey" PRIMARY KEY("org_id","run_id","shard","step")
);
--> statement-breakpoint
ALTER TABLE "ingest_model_costs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ingest_model_costs" ADD CONSTRAINT "ingest_model_costs_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "ingest_model_costs" AS PERMISSIVE FOR ALL TO public USING ("ingest_model_costs"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("ingest_model_costs"."org_id" = current_setting('app.organization_id', true));