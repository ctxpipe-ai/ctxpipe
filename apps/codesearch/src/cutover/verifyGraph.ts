import { parseArgs } from "node:util"

import {
  compareGraphSnapshots,
  readGraphSnapshot,
} from "../../../../shared/falkordb-transfer.js"
import {
  graphTotals,
  readTransferManifest,
  runCli,
  transferFromUrl,
} from "./transfer.js"

/*
 * verify-graph (CTX-1217): after FalkorDB starts on AWS with the imported
 * RDB. It compares the graph list, the node and edge counts and the module
 * version with the manifest of the export, and exits 1 on a difference.
 *
 *   bun run cutover:verify-graph --from s3://<bucket>/<prefix>/<run-id>
 *
 * It reads the FalkorDB URL from GRAPH_DB_URI, so that the password is not
 * in the command line. `--falkordb` replaces it. The problems give each
 * graph by its position in the export, not by its name (an organization id).
 */

if (import.meta.main) {
  const { values } = parseArgs({
    options: { from: { type: "string" }, falkordb: { type: "string" } },
  })
  runCli(async () => {
    const falkordb = values.falkordb ?? process.env["GRAPH_DB_URI"]
    if (!values.from || !falkordb)
      throw new Error(
        "Usage: GRAPH_DB_URI=redis://… verify-graph --from s3://bucket/prefix/run-id [--falkordb redis://…]",
      )
    const manifest = await readTransferManifest(transferFromUrl(values.from))
    if (!manifest) throw new Error(`${values.from} has no manifest.`)
    const actual = await readGraphSnapshot(falkordb)
    const problems = compareGraphSnapshots(manifest.falkordb, actual)
    return {
      ok: problems.length === 0,
      problems,
      moduleVersion: actual.moduleVersion,
      ...graphTotals(actual.graphs),
    }
  })
}
