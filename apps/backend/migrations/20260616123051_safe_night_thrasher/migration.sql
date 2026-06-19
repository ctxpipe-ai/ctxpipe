ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "instruction_units" integer;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "evidence_last_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "freshness_lt24h" integer;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "freshness_lt7d" integer;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "freshness_lt30d" integer;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "graph_total_nodes" integer;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "graph_total_edges" integer;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "graph_entity_types" integer;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "graph_relationship_types" integer;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "graph_isolated_nodes" integer;--> statement-breakpoint
ALTER TABLE "dashboard_metric_snapshots" ADD COLUMN "graph_average_degree" real;