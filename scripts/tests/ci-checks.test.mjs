import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

import { failedChecks, failedIds } from "../checks/rerun-failed.mjs"
import { noteTables } from "../checks/trace-tables.mjs"

// The tests of the check runner and its trace that read no file of the apps
// or packages, except the eval gate and the backend packages of the edge
// hooks. ci-checks-repo.test.mjs has the tests that read the whole
// repository, so a change to an app selects only that check.

const root = fileURLToPath(new URL("../../", import.meta.url))
const script = (name) => join(root, "scripts/checks", name)
const node = (args, input) =>
  spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  })

test("the container lanes run on the platform that the toolchain record names", () => {
  // The Merge gate manifest job records container-platform from its own
  // Docker server. Each job that runs a lane with container-platform in its
  // key must run on the same runner architecture.
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const runner = (job) => {
    const start = workflow.indexOf(`\n  ${job}:\n`)
    assert.notEqual(start, -1, job)
    const end = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/)
    const body = workflow.slice(start, end === -1 ? undefined : start + 1 + end)
    return /\n    runs-on: (\S+)/.exec(body)?.[1]
  }
  const arch = (label) => (label.endsWith("-arm") ? "arm64" : "x64")
  const recorded = arch(runner("merge-gate-manifest"))
  for (const job of ["test-shards", "codesearch"])
    assert.equal(arch(runner(job)), recorded, job)
})

test("with --manifest, the runner reads the checks from that file and lists none", () => {
  // A step with a credential runs the checks of a manifest that an earlier
  // step listed without it. A check that is not in the manifest is unknown,
  // even when the repository has it.
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-checks-"))
  try {
    const manifest = join(directory, "manifest.json")
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, checks: [] }))
    const id = "vitest:ui:apps/ui/src/components/onboarding/org-name.test.ts"
    const result = node([script("run.mjs"), "--manifest", manifest], `${id}\n`)
    assert.equal(result.status, 1, result.stderr)
    const [record] = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      [record.id, record.status, record.message],
      [id, "error", "Unknown check id"],
    )
    assert.equal(node([script("run.mjs"), "--manifest"], `${id}\n`).status, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the edge hooks record names, never statement text or data", () => {
  // The hooks resolve the packages as the lane does, so run in apps/backend.
  const probe = `
    import { readFileSync } from "node:fs"
    import { createRequire } from "node:module"
    import { installEdges, takeEdges } from ${JSON.stringify(script("trace-edges.mjs"))}
    const root = ${JSON.stringify(root)}
    const recorded = await installEdges(root, root + ".trace-out/")
    const lane = createRequire(process.cwd() + "/package.json")
    const { Hono } = await import("hono")
    const app = new Hono()
    app.use("*", async (_c, next) => next())
    app.get("/v1/things/:id", (c) => c.text("ok"))
    await app.request("/v1/things/42?secret=1")
    readFileSync(root + "package.json")
    const { Client } = lane("pg")
    new Client().query({ text: 'select "id" from "users" where "email" = $1', values: ["a@b.c"] }).catch(() => {})
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js")
    const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js")
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
    const server = new McpServer({ name: "probe", version: "1" })
    server.registerTool("probe_tool", { description: "probe" }, async () => ({ content: [] }))
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new McpClient({ name: "c", version: "1" })
    await client.connect(b)
    await client.callTool({ name: "probe_tool", arguments: {} })
    const edges = takeEdges()
    process.stdout.write(JSON.stringify({
      recorded,
      edges: Object.fromEntries(Object.entries(edges).map(([k, v]) => [k, [...v]])),
    }))
    process.exit(0)
  `
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", probe],
    {
      cwd: join(root, "apps/backend"),
      encoding: "utf8",
    },
  )
  assert.equal(result.status, 0, result.stderr)
  const { recorded, edges } = JSON.parse(result.stdout)
  for (const kind of ["reads", "dirs", "tables", "routes", "steps", "tools"])
    assert.ok(recorded.includes(kind), kind)
  assert.ok(!recorded.includes("models"))
  assert.deepEqual(edges.routes, ["GET /v1/things/:id"])
  assert.deepEqual(edges.read, ["users"])
  assert.deepEqual(edges.tools, ["probe_tool"])
  assert.ok(edges.reads.includes("package.json"))
  assert.ok(
    !result.stdout.includes("a@b.c") && !result.stdout.includes("secret"),
  )
})

test("the table hook reads the tables of a query and skips schema statements", () => {
  const tables = (text) => {
    const edges = { read: new Set(), write: new Set() }
    noteTables(text, edges)
    return [[...edges.read], [...edges.write]]
  }
  assert.deepEqual(
    tables(
      'select "a" from "users" left join lateral (select 1 from "members" "m") on true',
    ),
    [["users", "members"], []],
  )
  assert.deepEqual(
    tables(
      'insert into "public"."users" ("id") values ($1) on conflict ("id") do update set "id" = excluded."id"',
    ),
    [[], ["users"]],
  )
  assert.deepEqual(tables("select * from jobs for update skip locked"), [
    ["jobs"],
    [],
  ])
  assert.deepEqual(tables('select * from "openworkflow"."workflow_runs"'), [
    ["openworkflow.workflow_runs"],
    [],
  ])
  assert.deepEqual(
    tables("select extract(epoch from now()) from unnest($1::text[])"),
    [[], []],
  )
  assert.deepEqual(
    tables(
      '-- a\nCREATE TABLE "z" ("id" text REFERENCES "users" ON UPDATE CASCADE)',
    ),
    [[], []],
  )
  assert.deepEqual(tables('TRUNCATE "users"'), [[], []])
})

test("the table hook never takes a name from literal text or a comment", () => {
  const tables = (text) => {
    const edges = { read: new Set(), write: new Set() }
    noteTables(text, edges)
    return [[...edges.read], [...edges.write]]
  }
  assert.deepEqual(
    tables(`SELECT 'from "made_up_private_note"' AS body FROM users`),
    [["users"], []],
  )
  assert.deepEqual(
    tables(
      "-- from made_up_secret\nselect /* join made_up_other /* nested */ */ 1 from users",
    ),
    [["users"], []],
  )
  assert.deepEqual(
    tables(
      "select $q$ from made_up_dollar $q$, E'it\\'s from made_up_escape', 'a''from made_up_quote' from users",
    ),
    [["users"], []],
  )
  // A quoted identifier outside a table position is not a table either.
  assert.deepEqual(tables('select "from made_up_alias" from users'), [
    ["users"],
    [],
  ])
  assert.deepEqual(
    tables("update users set note = 'delete from made_up_private'"),
    [[], ["users"]],
  )
})

test("a failure of the table hook never changes the query or its result", () => {
  const probe = `
    import { createRequire } from "node:module"
    import { installEdges, takeEdges } from ${JSON.stringify(script("trace-edges.mjs"))}
    const lane = createRequire(process.cwd() + "/package.json")
    const { Client } = lane("pg")
    const calls = []
    Client.prototype.query = function (config) {
      calls.push(config.text)
      return "result"
    }
    await installEdges(${JSON.stringify(root)}, "/nowhere/")
    // The first read of the text throws, inside the hook only.
    let reads = 0
    const config = {
      get text() {
        if (reads++ === 0) throw new Error("boom")
        return "select 1 from users"
      },
    }
    const result = new Client().query(config)
    process.stdout.write(JSON.stringify({ result, calls, read: [...takeEdges().read] }))
    process.exit(0)
  `
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", probe],
    { cwd: join(root, "apps/backend"), encoding: "utf8" },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    result: "result",
    calls: ["select 1 from users"],
    read: [],
  })
})

test("a Vitest exit failure fails every record that has not failed", async () => {
  const { markExitFailure, suiteRecord } = await import("../checks/lanes.mjs")
  const records = [
    { id: "a", status: "passed", durationMs: 1, cases: [] },
    { id: "b", status: "failed", durationMs: 1, cases: [] },
    { id: "c", status: "skipped", durationMs: 1, cases: [] },
  ]
  assert.deepEqual(markExitFailure(records, { status: 0 }), records)
  const marked = markExitFailure(records, { status: 1 })
  assert.deepEqual(
    marked.map(({ status }) => status),
    ["error", "failed", "error"],
  )
  assert.match(marked[0].message, /Vitest failed \(exit 1\)/)
  // A suite that ran has results: its record gets no origin.
  assert.equal(marked[0].origin, undefined)
  // A record without a suite is a fault of the runner.
  const missing = suiteRecord("m", undefined)
  assert.equal(markExitFailure([missing], { status: 1 })[0].origin, "runner")
  // A load error of a test file is its own fault: no origin.
  const loadError = { id: "d", status: "error", durationMs: 1, cases: [] }
  assert.equal(markExitFailure([loadError], { status: 1 })[0].origin, undefined)
  assert.match(
    markExitFailure(records, { status: null, signal: "SIGKILL" })[0].message,
    /SIGKILL/,
  )
})

test("an eval case verdict is the eval gate for that case", async () => {
  const { caseVerdict } = await import("../checks/evals.mjs")
  const run = (a, b) => ({
    iterations: 3,
    passes: { m1: { x: a }, m2: { x: b } },
  })
  const baseline = {
    recordedAt: "",
    models: {
      m1: { aggregate: 1, cases: { x: 1 } },
      m2: { aggregate: 1, cases: { x: 1 } },
    },
  }
  const verdict = async (...args) =>
    (await caseVerdict(...args)).cases.map((c) => c.status)
  assert.deepEqual(await verdict(run(3, 3), "x", baseline), [
    "passed",
    "passed",
  ])
  // 2 of 3 is under the floor of the gate, and 3 of 3 is not required for 0.9.
  assert.deepEqual(await verdict(run(2, 3), "x", baseline), [
    "failed",
    "passed",
  ])
  assert.deepEqual(await verdict(run(3, 3), "x", null), ["passed", "passed"])
  // One model is under the gate minimum of models.
  const single = await caseVerdict(
    { iterations: 3, passes: { m1: { x: 3 } } },
    "x",
    null,
  )
  assert.match(single.general.join(), /at least 2 models/)
  // A model without a baseline entry for the case gets only the floor.
  const partial = {
    recordedAt: "",
    models: { m1: { aggregate: 1, cases: { y: 1 } } },
  }
  const floor = await caseVerdict(run(2, 3), "x", partial)
  assert.deepEqual(
    floor.cases.map((c) => c.status),
    ["failed", "passed"],
  )
  assert.match(floor.cases[1].message, /no baseline/)
  assert.doesNotMatch(
    (await caseVerdict(run(3, 3), "x", baseline)).cases[0].message,
    /no baseline/,
  )
  // A whole-run failure is not a case failure.
  assert.deepEqual(
    single.cases.map((c) => c.status),
    ["passed"],
  )
})

test("the runner and the tests of the CI scripts import only by literal specifiers", () => {
  // The cache key of a check follows each import() of the runner's closure,
  // and of the test file of a policy check. A computed specifier makes the
  // selector refuse a key for every check, or for that test, and then the
  // merge gate runs that test on each pull request that changes its inputs.
  const seen = new Set()
  const computed = []
  const visit = (file) => {
    // A test can name a path in a string that is not an import.
    if (seen.has(file) || !existsSync(file)) return
    seen.add(file)
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(/\bimport\(\s*(?![\s"'`)])/g))
      computed.push(`${file}@${match.index}`)
    for (const match of text.matchAll(
      /(?:from\s+|\bimport\(\s*)["'](\.[^"']+\.(?:mjs|js|ts))["']/g,
    ))
      visit(join(file, "..", match[1]))
  }
  visit(script("run.mjs"))
  for (const name of readdirSync(join(root, "scripts/tests")))
    if (name.endsWith(".test.mjs")) visit(join(root, "scripts/tests", name))
  assert.ok(seen.size > 5)
  assert.deepEqual(computed, [])
})

test("the rerun takes each failed record below the results once, and no rerun record", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-rerun-"))
  const write = (path, records) => {
    mkdirSync(join(directory, path, ".."), { recursive: true })
    writeFileSync(
      join(directory, path),
      records.map((record) => JSON.stringify(record)).join("\n"),
    )
  }
  write("backend/records.ndjson", [
    { id: "vitest:backend:b.test.ts", status: "failed" },
    { id: "vitest:backend:a.test.ts", status: "passed" },
    { id: "vitest:backend:e.test.ts", status: "error" },
  ])
  write("ui/deep/records.ndjson", [
    { id: "vitest:ui:a.test.tsx", status: "failed" },
    { id: "vitest:backend:b.test.ts", status: "failed" },
  ])
  // An earlier rerun is not a source of failures.
  write("rerun/rerun.ndjson", [
    { id: "vitest:ui:z.test.tsx", status: "failed" },
  ])
  assert.deepEqual(failedIds(directory), [
    "vitest:backend:b.test.ts",
    "vitest:ui:a.test.tsx",
  ])
  assert.deepEqual(failedIds(directory, 1), ["vitest:backend:b.test.ts"])
  assert.deepEqual(failedIds(join(directory, "missing")), [])
  const summary = failedChecks(directory, 1)
  assert.equal(summary.total, failedIds(directory).length)
  assert.deepEqual(summary.ids, ["vitest:backend:b.test.ts"])
  assert.deepEqual(summary.notRerun, failedIds(directory).slice(1))
  rmSync(directory, { recursive: true })
})

test("the rerun of selected.mjs reads MANIFEST and lists no checks", () => {
  // selected.mjs calls rerun-failed.mjs in its own process, so the rerun
  // has the MANIFEST of the step. A check that is not in that manifest is
  // unknown, even when the repository has it: the rerun did not list.
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-rerun-"))
  try {
    const id = "vitest:ui:apps/ui/src/components/onboarding/org-name.test.ts"
    const manifest = join(directory, "manifest.json")
    writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, checks: [] }))
    writeFileSync(
      join(directory, "records.ndjson"),
      `${JSON.stringify({ id, status: "failed" })}\n`,
    )
    const run = spawnSync(
      process.execPath,
      [script("rerun-failed.mjs"), directory],
      {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, MANIFEST: manifest },
      },
    )
    assert.equal(run.status, 0, run.stderr)
    const [record] = readFileSync(
      join(directory, "rerun", "rerun.ndjson"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      [record.id, record.status, record.message],
      [id, "error", "Unknown check id"],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a merge of no trace writes the empty trace of HEAD", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-empty-trace-"))
  try {
    const out = join(directory, "trace.json.gz")
    const result = node([script("trace.mjs"), "merge", out])
    assert.equal(result.status, 0, result.stderr)
    const trace = JSON.parse(gunzipSync(readFileSync(out)).toString("utf8"))
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
    assert.deepEqual(trace, {
      schemaVersion: 1,
      commit: head.stdout.trim(),
      checks: [],
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
