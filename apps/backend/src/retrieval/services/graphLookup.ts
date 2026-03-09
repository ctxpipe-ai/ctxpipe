import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"

export type GraphNode = {
  id: string
  orgId: string
  [key: string]: unknown
}

/**
 * Looks up a single node by id in the graph.
 * Uses parameterized Cypher and org filter for tenant isolation.
 */
export async function graphLookup(
  orgId: string,
  orgSlug: string,
  nodeId: string,
): Promise<GraphNode | null> {
  return withGraphClient({ orgId, orgSlug }, async () => {
    const driver = getGraphClient()
    const { records } = await driver.executeQuery(
      `MATCH (n)
       WHERE n.id = $nodeId AND n.orgId = $orgId
       RETURN n
       LIMIT 1`,
      { nodeId, orgId },
    )

    if (records.length === 0) return null
    const node = records[0]?.get("n")
    if (!node) return null

    const props =
      (node as { properties?: Record<string, unknown> }).properties ?? {}
    const toPlain = (v: unknown): unknown =>
      v != null && typeof v === "object" && "toNumber" in v
        ? (v as { toNumber: () => number }).toNumber()
        : v
    return {
      id: String(props.id ?? nodeId),
      orgId: String(props.orgId ?? orgId),
      ...Object.fromEntries(
        Object.entries(props).map(([k, v]) => [k, toPlain(v)]),
      ),
    } as GraphNode
  })
}
