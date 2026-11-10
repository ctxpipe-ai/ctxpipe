import { parseArgs } from "node:util"

import {
  compareGraphSnapshots,
  readGraphSnapshot,
} from "../../../../shared/falkordb-transfer.js"
import { readTransferManifest, runCli, transferFromUrl } from "./transfer.js"

/*
 * verify-graph (CTX-1217): after FalkorDB starts on AWS with the imported
 * RDB. It compares the graph list, the node and edge counts and the module
 * version with the manifest of the export, and exits 1 on a difference.
 *
 *   bun run cutover:verify-graph --from s3://<bucket>/<prefix>/<run-id> \
 *     --falkordb "$GRAPH_DB_URI"
 */

if (import.meta.main) {
  const { values } = parseArgs({
    options: { from: { type: "string" }, falkordb: { type: "string" } },
  })
  runCli(async () => {
    if (!values.from || !values.falkordb)
      throw new Error(
        "Usage: verify-graph --from s3://bucket/prefix/run-id --falkordb redis://…",
      )
    const manifest = await readTransferManifest(transferFromUrl(values.from))
    if (!manifest?.falkordb)
      throw new Error(`${values.from} has no manifest with an RDB.`)
    const actual = await readGraphSnapshot(values.falkordb)
    const problems = compareGraphSnapshots(manifest.falkordb, actual)
    return {
      ok: problems.length === 0,
      problems,
      moduleVersion: actual.moduleVersion,
      graphs: actual.graphs.length,
      nodes: actual.graphs.reduce((sum, graph) => sum + graph.nodes, 0),
      edges: actual.graphs.reduce((sum, graph) => sum + graph.edges, 0),
    }
  })
}
