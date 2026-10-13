/**
 * The ingestion v2 parent workflow (ADR-052, T09). Its run id is the
 * `<runId>` of the run's ingest sandboxes and ingest refs.
 */
export const INGESTION_V2_WORKFLOW_NAME = "repository-ingestion-v2"

/**
 * The input of an ingestion v2 run. `orgId` is a top-level field: the org
 * sweep reads it to find the unfinished runs of an org. T09 adds the other
 * fields.
 */
export type IngestionV2RunInput = {
  orgId: string
  /**
   * A shadow run publishes nothing, and its ingest refs stay 7 days after it
   * finished for the comparison. The ref clean-up reads this field.
   */
  shadow: boolean
}
