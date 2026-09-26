import { log } from "../../observability/logger.js"
import { getConfig, getGraphClient } from "./client.js"

const SAFE_LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `${orgId}\0${kind}` already attempted by this process. */
const attempted = new Set<string>()

function nodeIdIndexStatement(
  provider: ReturnType<typeof getConfig>["provider"],
  kind: string,
): string | null {
  switch (provider) {
    case "falkordb":
      return `CREATE INDEX FOR (n:${kind}) ON (n.id)`
    case "neo4j-enterprise":
    case "neo4j-community":
      return `CREATE INDEX IF NOT EXISTS FOR (n:${kind}) ON (n.id)`
    case "memgraph":
      return `CREATE INDEX ON :${kind}(id)`
    case "neptune":
      return null
  }
}

/**
 * Ensures an `id` index per node kind so projection MERGEs look nodes up
 * instead of scanning every node of that kind. Neptune indexes on its own.
 * Call inside withGraphClient. A failure (e.g. no schema privilege) costs
 * speed, not correctness, so it is logged and not thrown.
 */
export async function ensureNodeIdIndexes(
  orgId: string,
  kinds: Iterable<string>,
): Promise<void> {
  const { provider } = getConfig()
  const driver = getGraphClient()

  for (const kind of new Set(kinds)) {
    const key = `${orgId}\0${kind}`
    if (attempted.has(key) || !SAFE_LABEL.test(kind)) continue
    attempted.add(key)

    const statement = nodeIdIndexStatement(provider, kind)
    if (!statement) continue

    try {
      await driver.executeQuery(statement)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (/already (indexed|exists)/i.test(error)) continue
      log.warn({
        step: "graph.ensure_node_id_index",
        message: "Could not create node id index; projection will scan instead",
        orgId,
        kind,
        provider,
        error,
      })
    }
  }
}
