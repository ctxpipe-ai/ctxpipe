import { client } from "@/lib/api"
import { readApiJson } from "@/lib/api-result"
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
  const body = await readApiJson<{
    target: SuggestedConnectorSyncTarget | null
  }>(res, { message: "Failed to load connector repository suggestion" })
  return body.target
}
