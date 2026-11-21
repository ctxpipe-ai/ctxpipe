/**
 * Measures the hybrid search of KnowledgeStore (ADR-068 decision 1) on
 * 1 million made-up chunks in one Workspace, among the chunks of other
 * Workspaces and orgs. It is not a CI check (CTX-1402).
 *
 * Each document is a file version with a tree row of the branch `main`
 * (ADR-071). 5% of the documents also have an older file version that a
 * newer tree row replaced and that the cleanup did not remove yet, so the
 * search filters by the tree view, as in a Workspace that changes. On
 * 100k documents (200k chunks), the vector query took 68 ms where the
 * shape before ADR-071 took 58 ms (CTX-1457).
 *
 * Usage (apps/backend):
 *   pnpm exec tsx src/scripts/knowledgeSearchBenchmark.ts --url <server URL>
 *     [--chunks <n>] [--runs <n>]
 *
 * `--url` is a ClickHouse server, with a user that can make a database and
 * drop the caches, for example a container of the pinned image. The script
 * makes the database `knowledge_benchmark` again on each run.
 *
 * "warm": the caches hold the data. "cold": before each search, each
 * ClickHouse cache is dropped. The page cache of the operating system stays,
 * because a container cannot drop it.
 *
 * The report goes to stdout as JSON: p50 and p95 of the full search (two
 * round trips) and of each ClickHouse query of it (`query_duration_ms`).
 */
import { type ClickHouseClient, createClient } from "@clickhouse/client"

import {
  createKnowledgeStore,
  ORG_SETTING,
} from "../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import { initEvlog } from "../observability/logger.js"
import { flag } from "./cli-args.js"

const dimensions = 1024
const chunksPerDocument = 10
const vocabulary = 50_000
const target = { orgId: "org_bench", workspaceId: "ws_target" }

// The fill and OPTIMIZE statements run for minutes. The progress headers
// keep the HTTP connection busy.
const longRequests = {
  request_timeout: 3_600_000,
  clickhouse_settings: {
    send_progress_in_http_headers: 1,
    http_headers_progress_interval_ms: "10000",
  },
} as const

const progress = (message: string) => process.stderr.write(`${message}\n`)

function positiveFlag(argv: string[], name: string, fallback: number): number {
  const value = Number(flag(argv, name) ?? fallback)
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`)
  return value
}

/**
 * Inserts `chunks` made-up chunks into one Workspace, with one document row
 * (the file version `v1`) for each `chunksPerDocument` chunks, and a tree
 * row of `main` at tree version 1 for each document. Each chunk has a random
 * vector and 60 random words of the form `w<n>`. Each 20th document also
 * has the file version `v0`, with the same count of chunks: its tree row has
 * tree version 1, and the row of `v1` has tree version 2 (the head that
 * `measure` reads). The server makes the rows.
 */
async function fill(
  client: ClickHouseClient,
  orgId: string,
  workspaceId: string,
  chunks: number,
): Promise<void> {
  const params = { orgId, workspaceId, chunks }
  const documents = `intDiv({chunks:UInt64} + ${chunksPerDocument - 1}, ${chunksPerDocument})`
  const replaced = (document: string) => `${document} % 20 = 0`
  const run = (query: string) =>
    client.command({
      query,
      query_params: params,
      clickhouse_settings: { [ORG_SETTING]: orgId },
    })
  await run(`INSERT INTO documents (org_id, workspace_id, doc_key, version,
      kind, status, title, path, observed_at)
    SELECT {orgId:String}, {workspaceId:String},
      concat('doc-', toString(number % ${documents})),
      if(number < ${documents}, 'v1', 'v0'), 'note', 'active',
      concat('Document w', toString(number % ${vocabulary})),
      concat('notes/doc-', toString(number % ${documents}), '.md'), now64(3)
    FROM numbers(2 * ${documents})
    WHERE number < ${documents} OR ${replaced(`(number - ${documents})`)}`)
  await run(`INSERT INTO trees (org_id, workspace_id, branch, doc_key,
      tree_version, kind, path, version, status, doc_kind, observed_at)
    SELECT {orgId:String}, {workspaceId:String}, 'main', doc_key,
      if(version = 'v1' AND ${replaced("toUInt64(substring(doc_key, 5))")}, 2, 1),
      'file', path, version, 'active', 'note', observed_at
    FROM documents
    WHERE org_id = {orgId:String} AND workspace_id = {workspaceId:String}`)
  await run(`INSERT INTO chunks (org_id, workspace_id, doc_key, version,
      ordinal, text, embedding)
    SELECT {orgId:String}, {workspaceId:String},
      concat('doc-', toString(intDiv(number % {chunks:UInt64}, ${chunksPerDocument}))),
      if(number < {chunks:UInt64}, 'v1', 'v0'),
      (number % {chunks:UInt64}) % ${chunksPerDocument},
      arrayStringConcat(arrayMap(
        i -> concat('w', toString(cityHash64(number, i) % ${vocabulary})),
        range(60)), ' '),
      arrayMap(i -> toBFloat16(randNormal(0, 1, number * ${dimensions} + i)), range(${dimensions}))
    FROM numbers(2 * {chunks:UInt64})
    WHERE number < {chunks:UInt64}
      OR ${replaced(`intDiv(number - {chunks:UInt64}, ${chunksPerDocument})`)}`)
}

/** Drops each ClickHouse cache. */
async function dropCaches(client: ClickHouseClient): Promise<void> {
  for (const cache of [
    "MARK CACHE",
    "UNCOMPRESSED CACHE",
    "PAGE CACHE",
    "PRIMARY INDEX CACHE",
    "QUERY CONDITION CACHE",
    "MMAP CACHE",
    "INDEX MARK CACHE",
    "INDEX UNCOMPRESSED CACHE",
    "TEXT INDEX TOKENS CACHE",
    "TEXT INDEX HEADER CACHE",
    "TEXT INDEX POSTINGS CACHE",
    "FILESYSTEM CACHE",
  ])
    await client.command({ query: `SYSTEM DROP ${cache}` })
}

function randomVector(): number[] {
  // The sum of 4 uniform values is close to a normal distribution.
  return Array.from(
    { length: dimensions },
    () => Math.random() + Math.random() + Math.random() + Math.random() - 2,
  )
}

const randomTerms = () =>
  Array.from({ length: 3 }, () => `w${Math.floor(Math.random() * vocabulary)}`)

function percentiles(values: number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
  return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)) }
}

async function measure(
  admin: ClickHouseClient,
  url: string,
  runs: number,
  cold: boolean,
) {
  const store = createKnowledgeStore(url)
  const scope = {
    orgId: target.orgId,
    heads: [
      { workspaceId: target.workspaceId, branch: "main", treeVersion: 2 },
    ],
  }
  const total: number[] = []
  let started = ""
  try {
    // One search first: it loads the caches for the warm runs.
    await store.search(scope, { vector: randomVector(), terms: randomTerms() })
    started = new Date().toISOString()
    for (let run = 0; run < runs; run++) {
      if (cold) await dropCaches(admin)
      const begin = performance.now()
      const hits = await store.search(scope, {
        vector: randomVector(),
        terms: randomTerms(),
      })
      total.push(performance.now() - begin)
      if (hits.length === 0) throw new Error("The search found nothing")
    }
  } finally {
    await store.close()
  }
  await admin.command({ query: "SYSTEM FLUSH LOGS" })
  const queries = await (
    await admin.query({
      query: `SELECT
          multiIf(query LIKE '%bitHammingDistance%', 'vector',
                  query LIKE '%hasToken(%', 'lexical',
                  query LIKE '%v.doc_kind AS kind%', 'documents', 'texts') AS part,
          groupArray(query_duration_ms) AS durations,
          round(avg(read_bytes) / 1048576, 1) AS readMiB
        FROM system.query_log
        WHERE type = 'QueryFinish' AND query_kind = 'Select'
          AND event_time_microseconds >= parseDateTime64BestEffort({started:String}, 3)
          AND position(Settings['${ORG_SETTING}'], {orgId:String}) > 0
        GROUP BY part`,
      query_params: { started, orgId: target.orgId },
      format: "JSONEachRow",
    })
  ).json<{ part: string; durations: number[]; readMiB: number }>()
  return {
    search: percentiles(total),
    queries: Object.fromEntries(
      queries.map((row) => [
        row.part,
        { ...percentiles(row.durations), readMiB: row.readMiB },
      ]),
    ),
  }
}

async function main(argv: string[]): Promise<void> {
  const serverUrl = flag(argv, "--url")
  if (!serverUrl) throw new Error("--url is required")
  const chunks = positiveFlag(argv, "--chunks", 1_000_000)
  const runs = positiveFlag(argv, "--runs", 30)
  const admin = createClient({ url: serverUrl, ...longRequests })
  try {
    await admin.command({
      query: "DROP DATABASE IF EXISTS knowledge_benchmark SYNC",
    })
    await admin.command({ query: "CREATE DATABASE knowledge_benchmark" })
    const url = `${serverUrl.replace(/\/$/, "")}/knowledge_benchmark`
    await migrateKnowledgeStore(url)
    const data = createClient({ url, ...longRequests })
    try {
      // Other orgs sort before and after the target; another Workspace of
      // the same org follows it.
      const other = Math.ceil(chunks / 5)
      for (const [orgId, workspaceId, count] of [
        ["org_aaa", "ws_other", other],
        [target.orgId, target.workspaceId, chunks],
        [target.orgId, "ws_zzz", other],
        ["org_zzz", "ws_other", other],
      ] as const) {
        progress(`fill ${orgId}/${workspaceId}: ${count} chunks`)
        await fill(data, orgId, workspaceId, count)
      }
      progress("merge the parts")
      for (const table of ["documents", "chunks", "trees"])
        await data.command({ query: `OPTIMIZE TABLE ${table} FINAL` })
    } finally {
      await data.close()
    }
    progress(`warm: ${runs} searches`)
    const warm = await measure(admin, url, runs, false)
    progress(`cold: ${runs} searches`)
    const cold = await measure(admin, url, runs, true)
    const [version] = await (
      await admin.query({
        query: "SELECT version() AS version",
        format: "JSONEachRow",
      })
    ).json<{ version: string }>()
    process.stdout.write(
      `${JSON.stringify({ version: version?.version, chunks, runs, warm, cold }, null, 2)}\n`,
    )
  } finally {
    await admin.close()
  }
}

// The migrations log through evlog. A silent log keeps stdout for the report.
initEvlog({ silent: true })
main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
