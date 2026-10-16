import { createRequire } from "node:module"

// Runs one graph query against FalkorDB and fails at the deadline. A server
// that accepts the connection but never answers once hung a CI job for 29
// minutes, because only the connect step had a timeout.
export const graphReady = async (uri, deadlineMs = 30_000) => {
  const { FalkorDB } = createRequire(
    new URL("../../apps/backend/package.json", import.meta.url),
  )("falkordb")
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`FalkorDB did not answer within ${deadlineMs} ms`)),
      deadlineMs,
    )
  })
  let graphDb
  const run = (async () => {
    graphDb = await FalkorDB.connect({
      url: uri,
      socket: { connectTimeout: 5_000, reconnectStrategy: false },
    })
    // A destroyed socket would otherwise throw as an unhandled error.
    graphDb.on("error", () => {})
    const graph = graphDb.selectGraph(
      `prerequisite_${process.pid}_${Date.now()}`,
    )
    try {
      const result = await graph.query("RETURN 1 AS ready")
      if (result.data?.[0]?.ready !== 1)
        throw new Error("FalkorDB did not execute the required graph query")
    } finally {
      await graph.delete()
    }
  })()
  run.catch(() => {})
  try {
    await Promise.race([run, deadline])
  } finally {
    clearTimeout(timer)
    // Drop the socket without waiting for a reply that may never come.
    graphDb?.close().catch(() => {})
  }
}
