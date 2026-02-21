import { codesearchBaseUrl } from "../../../lib/agentToolRuntime.js"

export async function reindex(state: {
  repositoryId: string
  fromHash?: string
  sourceBranch?: string
  targetHash: string
}) {
  const res = await fetch(`${codesearchBaseUrl()}/${state.repositoryId}/index`, {
    method: "POST",
  })
  if (!res.ok) {
    throw new Error(`codesearch reindex failed with status ${res.status}`)
  }
  return {
    indexedAt: new Date().toISOString(),
  }
}
