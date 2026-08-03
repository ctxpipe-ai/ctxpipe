import { client } from "@/lib/api"
import type { SuggestedConnectorSyncTarget } from "../types"

export const connectorSyncTargetKeys = {
  suggestion: (orgSlug: string) =>
    ["connector-sync-target-suggestion", orgSlug] as const,
}

export async function fetchSuggestedConnectorSyncTarget(
  orgSlug: string,
): Promise<SuggestedConnectorSyncTarget | null> {
  const res = await client[":orgSlug"].api.v1.connectors[
    "suggested-sync-target"
  ].$get({
    param: { orgSlug },
  })
  if (!res.ok) throw new Error("Failed to load connector repository suggestion")
  const body = (await res.json()) as {
    target: SuggestedConnectorSyncTarget | null
  }
  return body.target
}
