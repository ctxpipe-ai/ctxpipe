/**
 * Shadow mode of ingestion v2 (ADR-052 phase 2). After the old pipeline
 * ingests a repository of one of these test organizations (org ids), the
 * same SHA also goes through ingestion v2, which publishes nothing. Empty: no
 * shadow runs. This is committed config; it is not an environment variable.
 */
export const INGESTION_V2_SHADOW_ORG_IDS: ReadonlySet<string> = new Set<string>(
  [],
)
