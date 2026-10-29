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

import { deploySteps, fullRunResults, stepResults } from "../checks/gate.mjs"
import { jobOutputs } from "../checks/plan.mjs"
import { prerequisites } from "../checks/prerequisites.mjs"
import { uiBundledImports } from "../checks/projects.mjs"
import { failedChecks, failedIds } from "../checks/rerun-failed.mjs"
import { lintSteps, runsInOf } from "../checks/shard.mjs"
import { requiredStories } from "../ci/storybook-golden-select.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const evalCaseCount = () =>
  (
    readFileSync(join(root, "apps/backend/evals/mcp/cases.ts"), "utf8").match(
      /^ {4}id: "/gm,
    ) ?? []
  ).length
const script = (name) => join(root, "scripts/checks", name)
const schema = (name) =>
  JSON.parse(readFileSync(script(`schema/${name}.v1.schema.json`), "utf8"))
const node = (args, input) =>
  spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  })

// Covers the JSON Schema keywords that the committed schemas use.
const validate = (value, rule, document, path = "$") => {
  if (rule.$ref)
    return validate(
      value,
      document.$defs[rule.$ref.replace("#/$defs/", "")],
      document,
      path,
    )
  if ("const" in rule) assert.equal(value, rule.const, path)
  if (rule.enum) assert.ok(rule.enum.includes(value), `${path}: ${value}`)
  if (rule.type === "string") assert.equal(typeof value, "string", path)
  if (rule.type === "integer") assert.ok(Number.isInteger(value), path)
  if (rule.type === "number") assert.equal(typeof value, "number", path)
  if (rule.type === "boolean") assert.equal(typeof value, "boolean", path)
  if (rule.minimum !== undefined) assert.ok(value >= rule.minimum, path)
  if (rule.pattern) assert.match(value, new RegExp(rule.pattern), path)
  if (rule.type === "array") {
    assert.ok(Array.isArray(value), path)
    if (rule.uniqueItems)
      assert.equal(new Set(value).size, value.length, `${path}: duplicates`)
    if (rule.minItems !== undefined)
      assert.ok(value.length >= rule.minItems, path)
    if (rule.maxItems !== undefined)
      assert.ok(value.length <= rule.maxItems, path)
    for (const [index, item] of value.entries())
      validate(item, rule.items, document, `${path}[${index}]`)
  }
  if (rule.type === "object") {
    assert.equal(typeof value, "object", path)
    for (const key of rule.required ?? [])
      assert.ok(key in value, `${path}.${key}`)
    for (const [key, item] of Object.entries(value)) {
      const child = rule.properties?.[key] ?? rule.additionalProperties
      assert.ok(typeof child === "object", `${path}: unexpected ${key}`)
      validate(item, child, document, `${path}.${key}`)
    }
  }
}

test("the manifest matches its schema and lists each check of each family", async () => {
  const result = node([script("list.mjs")])
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(result.stdout)
  const document = schema("manifest")
  validate(manifest, document, document)
  const ids = manifest.checks.map(({ id }) => id)
  assert.equal(new Set(ids).size, ids.length)
  for (const lane of [
    "backend",
    "contracts",
    "vercel",
    "ui",
    "cli",
    "aws-cdk",
  ]) {
    const inventory = node([
      join(root, "scripts/ci/test-suite.mjs"),
      lane,
      "--list",
    ])
    assert.equal(inventory.status, 0, inventory.stderr)
    const files = manifest.checks.filter(
      (check) => check.family === "vitest" && check.lane === lane,
    )
    assert.equal(files.length, JSON.parse(inventory.stdout).length, lane)
  }
  const { prerequisites } = await import("../checks/prerequisites.mjs")
  for (const check of manifest.checks) {
    // A Storybook story and an eval case are cases of their file.
    assert.equal(
      check.id.split("#")[0],
      `${check.family}:${check.lane}:${check.file}`,
    )
    assert.equal(
      check.id.includes("#"),
      check.family === "storybook" || check.lane === "mcp",
      check.id,
    )
    assert.ok(existsSync(join(root, check.file)), check.file)
    assert.ok(existsSync(join(root, check.root)), check.root)
    assert.ok(check.file.startsWith(check.root), check.file)
    for (const input of check.inputs)
      assert.ok(
        existsSync(join(root, input.replace(/\/\*\*$/, ""))),
        `${check.lane}: ${input}`,
      )
    for (const name of check.prerequisites ?? [])
      assert.ok(prerequisites[name], `${check.id}: prerequisite ${name}`)
  }
  // Each family lists itself; each project of projects.json has a typecheck.
  const count = (family, lane) =>
    manifest.checks.filter(
      (check) => check.family === family && (!lane || check.lane === lane),
    ).length
  const projects = JSON.parse(
    readFileSync(join(root, "scripts/ci/projects.json"), "utf8"),
  )
  assert.equal(count("typecheck"), projects.length)
  // The projects that import the repo-root shared/ directory read it.
  for (const lane of ["backend", "codesearch", "ui"])
    assert.ok(
      manifest.checks
        .find((check) => check.family === "typecheck" && check.lane === lane)
        .inputs.includes("shared/**"),
      lane,
    )
  assert.equal(count("lint"), 3)
  assert.ok(count("policy") >= 8)
  assert.equal(count("eval", "mcp"), evalCaseCount())
  assert.equal(count("eval", "cli-memory"), 0)
  // Each eval check lists the MCP tools of its rules, sorted and unique.
  const evals = manifest.checks.filter((check) => check.family === "eval")
  for (const check of evals) {
    assert.ok(Array.isArray(check.tools), `${check.id}: tools`)
    assert.deepEqual(check.tools, [...new Set(check.tools)].sort(), check.id)
  }
  assert.deepEqual(
    evals.find((check) => check.id.endsWith("#stale-cursor")).tools,
    ["search_knowledge"],
  )
  assert.deepEqual(
    evals.find((check) => check.id.endsWith("#parallel-knowledge-and-code"))
      .tools,
    ["search_code", "search_knowledge"],
  )
  assert.equal(count("vitest", "latency"), 2)
  assert.equal(count("vitest", "upgrade"), 1)
  // The required golden stories are tagged (ci-storybook-golden.test.mjs),
  // so the golden lane holds at least them.
  assert.ok(count("storybook", "golden") >= requiredStories.length)
  assert.ok(count("storybook", "plays") > 0)
  // An expensive check states its intent in under about 40 words. A check
  // that calls a model or a wall clock is stochastic; a check that reads
  // remote state, base images by tag or a deployment is not cacheable.
  for (const check of manifest.checks) {
    const expensive =
      check.family === "eval" ||
      check.lane === "golden" ||
      check.lane === "latency" ||
      check.lane === "upgrade" ||
      check.family === "build" ||
      check.family === "deploy"
    if (expensive) {
      assert.ok(check.intent, `${check.id} has no intent`)
      assert.ok(
        check.intent.split(/\s+/).length <= 45,
        `${check.id}: long intent`,
      )
    }
    assert.equal(
      check.stochastic ?? false,
      check.family === "eval" || check.lane === "latency",
      check.id,
    )
    assert.equal(
      check.cacheable ?? true,
      !(
        check.lane === "terraform-plan" ||
        check.lane.startsWith("image-") ||
        check.family === "deploy"
      ),
      check.id,
    )
  }
  assert.ok(manifest.checks.some((check) => check.lane === "codesearch"))
  assert.ok(manifest.checks.some((check) => check.lane === "codesearch-bun"))
  // A cache key hashes a `value` variable, and holds only set or unset for a
  // `presence` variable.
  const env = (lane) =>
    manifest.checks.find(
      (check) => check.family === "vitest" && check.lane === lane,
    ).env
  const mode = (lane, name) =>
    env(lane).find((item) => item.name === name)?.mode
  assert.equal(mode("backend", "MODEL_PROVIDER"), "value")
  assert.equal(mode("backend", "GITHUB_TOKEN"), "presence")
  assert.equal(mode("backend", "AUTH_BASE_URL"), "presence")
  assert.equal(mode("vercel", "VERCEL_TOKEN"), "presence")
  assert.equal(env("ui"), undefined)
})

test("the runner runs exactly the given ids and writes one schema result for each", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-checks-"))
  try {
    const known = "vitest:ui:apps/ui/src/components/onboarding/org-name.test.ts"
    const ids = join(directory, "ids.txt")
    const input = `${known}\nvitest:ui:apps/ui/src/missing.test.ts\n${known}\n`
    const result = node([script("run.mjs")], input)
    // An unknown id is an error, so the run fails.
    assert.equal(result.status, 1, result.stderr)
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const document = schema("result")
    for (const record of records) validate(record, document, document)
    assert.ok(records.every((record) => record.schemaVersion === 1))
    assert.deepEqual(
      records.map(({ id, status }) => [id, status]).sort(),
      [
        ["vitest:ui:apps/ui/src/missing.test.ts", "error"],
        [known, "passed"],
      ].sort(),
    )
    const passed = records.find(({ id }) => id === known)
    assert.ok(passed.cases.length > 0)
    assert.ok(existsSync(join(root, passed.log)))
    assert.equal(node([script("run.mjs"), ids, "extra"]).status, 1)
    const none = node([script("run.mjs")], "\n\n")
    assert.equal(none.status, 1)
    assert.match(none.stderr, /no check ids given/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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

test("the runner traces the lines that each case executed", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-trace-"))
  try {
    const id = "vitest:ui:apps/ui/src/components/onboarding/org-name.test.ts"
    const result = node([script("run.mjs"), "--trace", directory], `${id}\n`)
    assert.equal(result.status, 0, result.stderr)
    const file = join(directory, "trace.json.gz")
    const trace = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"))
    const document = schema("trace")
    validate(trace, document, document)
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
    assert.equal(trace.commit, head.stdout.trim())
    assert.deepEqual(
      trace.checks.map((check) => check.id),
      [id],
    )
    const cases = new Map(trace.checks[0].cases.map((c) => [c.name, c]))
    const source = "apps/ui/src/components/onboarding/org-name.ts"
    const ran = (name, line) =>
      (cases.get(name)?.lines[source] ?? []).some(
        ([first, last]) => first <= line && line <= last,
      )
    // Module evaluation goes to <collect>: the PERSONAL_MAIL_DOMAINS set.
    assert.ok(ran("<collect>", 59))
    // A case owns the function body that it ran, and not the others.
    const work = "orgNameFromEmail names the organization after a work domain"
    assert.ok(ran(work, 40))
    assert.ok(!ran(work, 23))
    assert.ok(!ran("<collect>", 40))
    // The merge of one trace gives the same checks; a check twice is refused.
    const merged = join(directory, "merged.json.gz")
    const merge = (inputs) =>
      node([script("trace.mjs"), "merge", merged, ...inputs])
    assert.equal(merge([file]).status, 0)
    assert.deepEqual(
      JSON.parse(gunzipSync(readFileSync(merged)).toString("utf8")),
      trace,
    )
    assert.equal(merge([file, file]).status, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the trace code itself is not traced, also under jsdom", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-trace-"))
  try {
    const id = "vitest:ui:apps/ui/src/components/ui/Button.test.tsx"
    const result = node([script("run.mjs"), "--trace", directory], `${id}\n`)
    assert.equal(result.status, 0, result.stderr)
    const file = join(directory, "trace.json.gz")
    const trace = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"))
    const paths = trace.checks[0].cases.flatMap(({ lines }) =>
      Object.keys(lines),
    )
    assert.ok(paths.includes("apps/ui/src/components/ui/Button.tsx"))
    assert.deepEqual(
      paths.filter((path) => path.startsWith("scripts/checks/")),
      [],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a broken trace never changes the result of a run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-trace-"))
  try {
    // A part file that a killed worker cut off is an error of the trace only.
    const parts = join(directory, "parts")
    mkdirSync(parts)
    writeFileSync(join(parts, "a.json"), '{"file": "apps/ui/src/a.ts", "cas')
    const { laneChecks } = await import("../checks/trace.mjs")
    assert.throws(() => laneChecks(parts, "ui"))
    // A trace directory that cannot exist leaves the run and its result lines
    // as they are.
    const id = "vitest:ui:apps/ui/src/components/onboarding/org-name.test.ts"
    const blocked = join(directory, "blocked")
    writeFileSync(blocked, "a file, not a directory")
    const plain = node([script("run.mjs")], `${id}\n`)
    const traced = node([script("run.mjs"), "--trace", blocked], `${id}\n`)
    assert.equal(plain.status, 0, plain.stderr)
    assert.equal(traced.status, plain.status, traced.stderr)
    const status = (result) =>
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .map(({ id, status }) => [id, status])
    assert.deepEqual(status(traced), status(plain))
    assert.match(traced.stderr, /No trace/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the trace records the lines that a case runs in a Node child process", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-trace-"))
  try {
    // The CLI tests run the built bin/ctxpipe.js in a child process.
    const id = "vitest:cli:packages/cli/test/argv.test.ts"
    const result = node([script("run.mjs"), "--trace", directory], `${id}\n`)
    assert.equal(result.status, 0, result.stderr)
    const file = join(directory, "trace.json.gz")
    const trace = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"))
    const document = schema("trace")
    validate(trace, document, document)
    const [check] = trace.checks
    // A child wrote coverage, so `children` is recorded.
    assert.ok(check.recorded.includes("children"))
    assert.ok(
      check.recorded.includes("reads") && check.recorded.includes("dirs"),
    )
    assert.equal(trace.fsRecorded, undefined)
    const help = check.cases.find(({ name }) => name.includes("init --help"))
    // The source map of the build maps the child's lines to the source.
    assert.ok(help.lines["packages/cli/src/cli.ts"]?.length)
    assert.ok(help.lines["packages/cli/bin/ctxpipe.js"]?.length)
    assert.ok(
      !check.cases.find(({ name }) => name === "<collect>").lines[
        "packages/cli/src/cli.ts"
      ],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the trace records the files that a case runs in a Bun child process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-trace-"))
  try {
    // Each fixture case starts child.mjs, which runs known() from known.mjs.
    const fixtures = join(root, "scripts/tests/fixtures/trace-children")
    const parts = join(directory, "parts")
    const vitest = join(root, "apps/backend/node_modules/vitest/vitest.mjs")
    const result = spawnSync(
      process.execPath,
      [vitest, "run", `--reporter=${script("trace-reporter.mjs")}`],
      {
        cwd: fixtures,
        encoding: "utf8",
        env: { ...process.env, CTXPIPE_TRACE_PARTS: parts },
      },
    )
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const { laneChecks } = await import("../checks/trace.mjs")
    const checks = new Map(
      laneChecks(parts, "fixture").map((check) => [
        check.id.split("/").at(-1),
        check,
      ]),
    )
    const document = schema("trace")
    validate(
      {
        schemaVersion: 1,
        commit: "0".repeat(40),
        checks: [...checks.values()],
      },
      document,
      document,
    )
    const known = "scripts/tests/fixtures/trace-children/known.mjs"
    const lines = (file, name) =>
      checks.get(file).cases.find((c) => c.name === name).lines[known]
    // A Node child gives the lines of known() only.
    assert.deepEqual(lines("children.fixture.mjs", "a Node child"), [[1, 5]])
    // A Bun child gives the whole files that it loaded, also when a signal
    // stops it.
    assert.deepEqual(
      lines("children.fixture.mjs", "a Bun child that a signal stops"),
      [[1, 7]],
    )
    assert.ok(checks.get("children.fixture.mjs").recorded.includes("children"))
    // A signal stops a Node child before it writes its coverage: the lines
    // are missing, and the check does not claim `children`.
    assert.equal(
      lines("lost.fixture.mjs", "a Node child that a signal stops"),
      undefined,
    )
    assert.ok(!checks.get("lost.fixture.mjs").recorded.includes("children"))
    // A Bun child with its own `env` cannot load the preload: no `children`,
    // and the other files of the worker keep theirs.
    assert.ok(!checks.get("env.fixture.mjs").recorded.includes("children"))
    // A Node child that outlives its file writes its coverage after the part.
    assert.ok(!checks.get("late.fixture.mjs").recorded.includes("children"))
    // known.mjs runs in a Bun child in one case and in process in another.
    // The Bun file must not change the exact ranges of the in-process case.
    assert.deepEqual(lines("mixed.fixture.mjs", "a Bun child"), [[1, 7]])
    assert.deepEqual(lines("mixed.fixture.mjs", "in process"), [[1, 3]])
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

test("the table hook reads the tables of a query and skips schema statements", async () => {
  const { emptyEdges, noteTables } = await import("../checks/trace-edges.mjs")
  const tables = (text) => {
    const edges = emptyEdges()
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

test("the table hook never takes a name from literal text or a comment", async () => {
  const { emptyEdges, noteTables } = await import("../checks/trace-edges.mjs")
  const tables = (text) => {
    const edges = emptyEdges()
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

const records = (result) =>
  result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

test("an eval check refuses to run without the workbench variables", () => {
  const id = "eval:mcp:apps/backend/evals/mcp/cases.ts#stale-cursor"
  const env = { ...process.env }
  delete env.MODEL_PROVIDER_API_KEY
  delete env.MCP_EVAL_MODELS
  const result = spawnSync(process.execPath, [script("run.mjs")], {
    cwd: root,
    encoding: "utf8",
    input: `${id}\n`,
    env,
  })
  assert.equal(result.status, 1)
  const [record] = records(result)
  const document = schema("result")
  validate(record, document, document)
  assert.equal(record.status, "error")
  assert.equal(record.origin, "prerequisite")
  assert.match(record.message, /Prerequisite workbench failed/)
  assert.match(record.message, /MODEL_PROVIDER_API_KEY/)
  assert.match(record.message, /workbench environment/)
})

test("a project check runs its command and records its time in the trace", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-trace-"))
  try {
    const id = "policy:runners:scripts/ci/check-runners.mjs"
    const result = node([script("run.mjs"), "--trace", directory], `${id}\n`)
    assert.equal(result.status, 0, result.stderr)
    const [record] = records(result)
    const document = schema("result")
    validate(record, document, document)
    assert.equal(record.status, "passed")
    assert.deepEqual(
      record.cases.map(({ name }) => name),
      ["runners"],
    )
    assert.ok(existsSync(join(root, record.log)))
    const file = join(directory, "trace.json.gz")
    const trace = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"))
    const traceDocument = schema("trace")
    validate(trace, traceDocument, traceDocument)
    assert.deepEqual(trace.checks, [])
    assert.deepEqual(Object.keys(trace.durations), [id])
    // The merge keeps the durations and refuses one check twice.
    const merged = join(directory, "merged.json.gz")
    assert.equal(node([script("trace.mjs"), "merge", merged, file]).status, 0)
    assert.deepEqual(
      JSON.parse(gunzipSync(readFileSync(merged)).toString("utf8")).durations,
      trace.durations,
    )
    assert.equal(
      node([script("trace.mjs"), "merge", merged, file, file]).status,
      1,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the browser trace maps page coverage to source lines through the build's source maps", async () => {
  const { encode } = await import("@jridgewell/sourcemap-codec")
  const { browserTrace } = await import("../checks/storybook.mjs")
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-storybook-"))
  try {
    mkdirSync(join(directory, "assets"))
    // A built chunk of two functions on one line, from lines 1 and 2 of a
    // repo file. Only the second one ran.
    const source = "function a(){return 1}function b(){return 2}"
    const original = join(root, "apps/ui/src/components/onboarding/org-name.ts")
    writeFileSync(join(directory, "assets/chunk.js"), source)
    writeFileSync(
      join(directory, "assets/chunk.js.map"),
      JSON.stringify({
        version: 3,
        sources: [original],
        mappings: encode([
          [
            [0, 0, 0, 0],
            [13, 0, 0, 9],
            [22, 0, 1, 0],
            [35, 0, 1, 9],
          ],
        ]),
      }),
    )
    writeFileSync(join(directory, "assets/unmapped.js"), "function c(){}")
    const story = {
      id: "onboarding--org-name",
      importPath: "./src/components/onboarding/org-name.stories.tsx",
      exportName: "OrgName",
      tags: ["play-fn"],
    }
    const entry = (path, text, ranges) => ({
      url: `http://127.0.0.1:6006${path}`,
      source: text,
      functions: [{ ranges }],
    })
    const tracer = browserTrace(directory)
    const ran = entry("/assets/chunk.js", source, [
      { startOffset: 0, endOffset: source.length, count: 1 },
      { startOffset: 0, endOffset: 22, count: 0 },
    ])
    const record = tracer.check(story, 12, [ran], ["GET */api/v1/x"])
    const document = schema("trace")
    validate(
      { schemaVersion: 1, commit: "0".repeat(40), checks: [record] },
      document,
      document,
    )
    assert.equal(
      record.id,
      "storybook:plays:apps/ui/src/components/onboarding/org-name.stories.tsx#onboarding--org-name",
    )
    assert.deepEqual(record.recorded, ["browser", "mocks"])
    assert.deepEqual(record.cases[0].lines, {
      "apps/ui/src/components/onboarding/org-name.ts": [[2, 2]],
    })
    assert.deepEqual(record.cases[0].mocks, ["GET */api/v1/x"])
    // A built chunk without a map is a gap: no `browser`. A page that did
    // not expose its MSW handlers records no `mocks`.
    const gap = tracer.check(
      story,
      12,
      [
        ran,
        entry("/assets/unmapped.js", "function c(){}", [
          { startOffset: 0, endOffset: 14, count: 1 },
        ]),
      ],
      null,
    )
    assert.deepEqual(gap.recorded, [])
    assert.equal(tracer.check(story, 12, undefined, null), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
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

test("the files that the runner loads import only by literal specifiers", () => {
  // The cache key of a check follows each import() of the runner's closure.
  // A computed specifier makes the selector refuse a key for every check.
  const seen = new Set()
  const computed = []
  const visit = (file) => {
    if (seen.has(file)) return
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

test("every check has the root toolchain files among its inputs", () => {
  const result = node([script("list.mjs")])
  assert.equal(result.status, 0, result.stderr)
  const { checks } = JSON.parse(result.stdout)
  assert.ok(checks.length > 0)
  // The deploy checks read only their own files: they need only the Node
  // version of the toolchain, so that a dependency change selects the image
  // builds, not a preview deploy.
  for (const { id, family, inputs } of checks)
    for (const file of family === "deploy"
      ? [".node-version"]
      : [
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          ".node-version",
        ])
      assert.ok(inputs.includes(file), `${id} lacks input ${file}`)
})

test("the manifest lists a check for each job of the other pull request workflows", () => {
  const result = node([script("list.mjs")])
  assert.equal(result.status, 0, result.stderr)
  const checks = new Map(
    JSON.parse(result.stdout).checks.map((check) => [check.id, check]),
  )
  const lane = (family, name) =>
    [...checks.values()].filter(
      (check) => check.family === family && check.lane === name,
    )
  // cli-test.yaml runs the cli lane.
  assert.ok(lane("vitest", "cli").length > 0)
  assert.ok(lane("vitest", "cli")[0].inputs.includes("packages/cli/src/**"))
  // claude-plugin-test.yaml: each backend test file that its Backend tests job
  // names exists and is a check of the backend lane. The UI tests job runs
  // the ui lane.
  const workflow = readFileSync(
    join(root, ".github/workflows/claude-plugin-test.yaml"),
    "utf8",
  )
  const named = workflow
    .match(/^\s+src\/\S+\.test\.ts$/gm)
    .map((line) => `apps/backend/${line.trim()}`)
  assert.ok(named.length >= 5)
  for (const file of named) {
    assert.ok(existsSync(join(root, file)), `${file} does not exist`)
    assert.ok(checks.has(`vitest:backend:${file}`), file)
  }
  assert.ok(lane("vitest", "ui").length > 0)
  // The Lint and format job of ci.yaml runs the policy check of the plugin.
  const plugin = checks.get(
    "policy:claude-plugin:scripts/ci/check-claude-plugin.mjs",
  )
  assert.ok(plugin)
  assert.equal(plugin.family, "policy")
  assert.equal(plugin.root, "")
  assert.equal(plugin.runtime, "node")
  assert.equal(plugin.stochastic, undefined)
  for (const input of [
    "plugins/**",
    ".claude-plugin/**",
    "scripts/ci/check-claude-plugin.mjs",
    "scripts/checks/projects.mjs",
  ])
    assert.ok(plugin.inputs.includes(input), input)
  assert.ok(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8").includes(
      "run: node scripts/ci/check-claude-plugin.mjs",
    ),
  )
  // The Terraform plan: not cacheable, selected by the files of infra.
  const plan = checks.get("policy:terraform-plan:infra/main.tf")
  assert.ok(plan)
  assert.equal(plan.cacheable, false)
  assert.ok(plan.inputs.includes("infra/**"))
  assert.deepEqual(plan.prerequisites, ["terraform-plan"])
  assert.ok(plan.intent)
  // Each check that is not stochastic has a result in a full run: a lint or
  // policy check has a step of the Lint and format job, any other check has
  // a job. The Terraform plan has its own workflow.
  for (const check of checks.values()) {
    if (check.stochastic || check === plan) continue
    assert.ok(
      check.family === "lint" || check.family === "policy"
        ? Object.values(lintSteps).some((key) => check.id.startsWith(key))
        : runsInOf(check.id),
      check.id,
    )
  }
  // mcp-evals.yaml runs the eval cases; a model call is stochastic.
  assert.ok(lane("eval", "mcp").length > 0)
  for (const check of lane("eval", "mcp"))
    assert.equal(check.stochastic, true, check.id)
})

test("the manifest lists a build check for each production image and package of CI", () => {
  const result = node([script("list.mjs")])
  assert.equal(result.status, 0, result.stderr)
  const builds = new Map(
    JSON.parse(result.stdout)
      .checks.filter((check) => check.family === "build")
      .map((check) => [check.id, check]),
  )
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const job = (name) =>
    workflow.slice(
      workflow.indexOf(`\n  ${name}:\n`),
      workflow.indexOf("\n\n  ", workflow.indexOf(`\n  ${name}:\n`) + 1),
    )
  // The Production build job has one matrix entry for each image check: the
  // merge gate takes the job `Production build (<name>)` as the result of
  // `build:image-<name>:`. Each entry builds the Dockerfile of its check.
  // The entries of the full run are the JSON fallback of the matrix; in gate
  // mode the plan job gives the same entries for the selected images.
  const entries = JSON.parse(
    /production-builds \|\| '(\[[^']*\])'/.exec(job("production-builds"))[1],
  )
  const images = entries.map(
    ({ name, dockerfile }) => `build:image-${name}:${dockerfile}`,
  )
  assert.deepEqual(
    images.sort(),
    [...builds.keys()].filter((id) => id.startsWith("build:image-")),
  )
  assert.deepEqual(
    JSON.parse(jobOutputs(images, new Map())["production-builds"]).sort(
      (a, b) => a.name.localeCompare(b.name),
    ),
    entries.sort((a, b) => a.name.localeCompare(b.name)),
  )
  assert.ok(!job("production-builds").includes("pnpm install"))
  assert.equal(
    fullRunResults(
      [],
      {},
      stepResults({
        jobs: [{ name: "Production build (ui)", conclusion: "failure" }],
      }),
    )("build:image-ui:apps/ui/Dockerfile"),
    "failed",
  )
  assert.ok(job("packages").includes("pnpm -s checks:run"))
  const expected = {
    "build:image-backend:apps/backend/Dockerfile": [
      "apps/backend/**",
      "shared/**",
      "patches/**",
      ".dockerignore",
    ],
    "build:image-worker:apps/backend/Dockerfile.worker": [
      "apps/backend/**",
      "shared/**",
    ],
    "build:image-ui:apps/ui/Dockerfile": [
      "apps/ui/**",
      "apps/backend/package.json",
    ],
    "build:image-codesearch:apps/codesearch/Dockerfile": [
      "apps/codesearch/**",
      "shared/**",
    ],
    "build:image-docs:apps/docs/Dockerfile": ["apps/docs/**"],
    "build:image-chat-sandbox:scripts/chat-sandbox/Dockerfile": [
      "scripts/chat-sandbox/**",
    ],
    "build:package-backend:apps/backend/package.json": [
      "apps/backend/**",
      "shared/**",
    ],
    "build:package-codesearch:apps/codesearch/package.json": [
      "apps/codesearch/**",
      "shared/**",
    ],
    "build:package-aws-cdk:packages/aws-cdk/package.json": [
      "packages/aws-cdk/**",
    ],
    "build:package-cli:packages/cli/package.json": ["packages/cli/**"],
  }
  assert.deepEqual([...builds.keys()].sort(), Object.keys(expected).sort())
  for (const [id, inputs] of Object.entries(expected)) {
    const check = builds.get(id)
    assert.ok(existsSync(join(root, check.file)), `${check.file} is missing`)
    for (const input of [...inputs, "pnpm-lock.yaml"])
      assert.ok(check.inputs.includes(input), `${id} lacks input ${input}`)
    assert.ok(check.intent, id)
    const image = check.lane.startsWith("image-")
    // An image pulls base images by tag, so a result cache never reuses it;
    // a package build is a function of its inputs.
    assert.equal(check.cacheable ?? true, !image, id)
    assert.deepEqual(runsInOf(id), {
      job: image ? "production-builds" : "packages",
    })
  }
  assert.deepEqual(
    builds.get("build:image-codesearch:apps/codesearch/Dockerfile")
      .prerequisites,
    ["docker"],
  )
  // The backend and codesearch builds run Bun: a cache key holds its version.
  for (const name of ["backend", "codesearch"]) {
    const check = builds.get(`build:package-${name}:apps/${name}/package.json`)
    assert.equal(check.runtime, "bun")
    assert.deepEqual(check.prerequisites, ["bun"])
  }
  assert.equal(
    builds.get("build:package-cli:packages/cli/package.json").runtime,
    "node",
  )
})

test("the UI image selects on the backend files that the UI build bundles, not on the whole backend", () => {
  const result = node([script("list.mjs")])
  assert.equal(result.status, 0, result.stderr)
  const ui = JSON.parse(result.stdout).checks.find(
    (check) => check.id === "build:image-ui:apps/ui/Dockerfile",
  )
  // A plain path or a `/**` directory: the only input forms of this check.
  const selects = (path) =>
    ui.inputs.some((input) =>
      input.endsWith("/**")
        ? path.startsWith(input.slice(0, -2))
        : input === path,
    )
  for (const file of [...uiBundledImports(), "apps/backend/package.json"])
    assert.ok(ui.inputs.includes(file), file)
  // apps/ui/src/components/onboarding/org-name.ts imports it as a value.
  assert.ok(selects("apps/backend/src/domain/workspaces/slug.ts"))
  // No UI file imports it, but sources-file.ts and providers/git.ts, which
  // the UI imports, import it as a value: the build bundles it.
  const github = "apps/backend/src/domain/workspace-sources/providers/github"
  const uiFiles = readdirSync(join(root, "apps/ui/src"), { recursive: true })
  for (const file of uiFiles.filter((file) => /\.tsx?$/.test(file)))
    assert.ok(
      !readFileSync(join(root, "apps/ui/src", file), "utf8").includes(
        github.replace("apps/backend/src/", "backend/"),
      ),
      file,
    )
  assert.ok(selects(`${github}.ts`))
  // The UI imports it only as a type, which the build erases.
  assert.ok(
    !selects("apps/backend/src/routes/v1/workspace-sources-contract.ts"),
  )
  // The UI does not import it.
  assert.ok(!selects("apps/backend/src/app/app.ts"))
})

test("the manifest lists the preview deployment and its UI smoke test, and the gate reads their PR Deploy steps", () => {
  const result = node([script("list.mjs")])
  assert.equal(result.status, 0, result.stderr)
  const deploys = new Map(
    JSON.parse(result.stdout)
      .checks.filter((check) => check.family === "deploy")
      .map((check) => [check.id, check]),
  )
  const deploy = deploys.get("deploy:preview:.github/workflows/pr-deploy.yaml")
  const smoke = deploys.get(
    "deploy:preview-ui-smoke:scripts/ci/smoke-preview-ui.sh",
  )
  assert.deepEqual(
    [...deploys.keys()].sort(),
    [deploy.id, smoke.id].sort(),
    "each deploy check",
  )
  const workflow = readFileSync(
    join(root, ".github/workflows/pr-deploy.yaml"),
    "utf8",
  )
  // The deployment selects on each script that the workflow or a sourced
  // script sources or runs, and on each image that it builds.
  const sourced = new Set(
    [
      ...workflow.matchAll(/\$\{GITHUB_WORKSPACE\}\/(scripts\/[\w./-]+\.sh)/g),
    ].map(([, file]) => file),
  )
  for (const file of [...sourced])
    for (const [, name] of readFileSync(join(root, file), "utf8").matchAll(
      /"\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/([\w.-]+\.(?:sh|mjs))"/g,
    ))
      sourced.add(`scripts/${name}`)
  assert.ok(sourced.size >= 10)
  const images = [...workflow.matchAll(/^\s+dockerfile: (\S+)$/gm)].map(
    ([, file]) => file,
  )
  assert.equal(images.length, 4)
  for (const input of [
    ...sourced,
    ...images,
    "apps/backend/migrations/**",
    "infra/module/ctxpipe/railway.tf",
  ])
    assert.ok(deploy.inputs.includes(input), `deploy lacks input ${input}`)
  for (const check of deploys.values()) {
    for (const input of check.inputs.filter((item) => !item.endsWith("/**")))
      assert.ok(existsSync(join(root, input)), `${input} is missing`)
    assert.equal(check.cacheable, false, check.id)
    assert.ok(check.intent, check.id)
    // Its job is in pr-deploy.yaml, and it has no profile of a gated run.
    assert.deepEqual(runsInOf(check.id), { job: "pr-deploy" })
  }
  // The smoke test needs the deployed preview, which needs the pull request.
  assert.deepEqual(smoke.prerequisites, ["preview-pr"])
  assert.equal(prerequisites["preview-deployment"], undefined)
  assert.deepEqual(deploy.prerequisites, ["preview-pr"])
  // A plain app code change does not select the deployment: no input is a
  // whole app directory, and no app source input imports a repo module (a
  // selector follows the imports of a source input).
  for (const input of [...deploy.inputs, ...smoke.inputs]) {
    assert.ok(!/^apps\/[^/]+\/(src\/)?\*\*$/.test(input), input)
    if (/^apps\/.*\.(ts|tsx|mjs)$/.test(input))
      assert.doesNotMatch(
        readFileSync(join(root, input), "utf8"),
        /from "\.{1,2}\//,
        input,
      )
    // A dependency change selects the image builds, not a preview deploy.
    assert.ok(!/(^|\/)(pnpm-lock\.yaml|package\.json)$/.test(input), input)
  }
  // Each deploy check is one step of the deploy job of pr-deploy.yaml.
  const job = workflow.slice(workflow.indexOf("\n  deploy_pr_environment:\n"))
  assert.ok(job.includes("name: Deploy PR environment (Railway + Neon)\n"))
  assert.deepEqual(Object.values(deploySteps).sort(), [
    "deploy:preview-ui-smoke:",
    "deploy:preview:",
  ])
  for (const step of Object.keys(deploySteps))
    assert.ok(job.includes(`- name: ${step}\n`), step)
  assert.match(
    job,
    /- name: Smoke-test the preview UI\n\s+run: bash scripts\/ci\/smoke-preview-ui\.sh /,
  )
  // The gate reads the result of each step of the newest PR Deploy run. A
  // run without the deploy job (a failed job before it, or a run that has
  // not ended) gives a missing result, which fails the gated run.
  const deployRun = (conclusions) => ({
    jobs: [
      {
        name: "Deploy PR environment (Railway + Neon)",
        steps: Object.keys(deploySteps).map((name, index) => ({
          name,
          conclusion: conclusions[index],
        })),
      },
    ],
  })
  const read = (run) => fullRunResults([], {}, stepResults({ jobs: [] }, run))
  assert.equal(read(deployRun(["success", "failure"]))(deploy.id), "passed")
  assert.equal(read(deployRun(["success", "failure"]))(smoke.id), "failed")
  assert.equal(read(deployRun(["failure", "skipped"]))(deploy.id), "failed")
  assert.match(
    read(deployRun(["failure", "skipped"]))(smoke.id),
    /^missing result \(job pr-deploy/,
  )
  assert.match(read(undefined)(deploy.id), /^missing result/)
  // A failed job before the deploy job skips it: the deployment failed.
  const skipped = {
    status: "completed",
    jobs: [
      { name: "Migrate PR Neon branch", conclusion: "failure" },
      {
        name: "Deploy PR environment (Railway + Neon)",
        conclusion: "skipped",
        steps: [],
      },
    ],
  }
  assert.equal(read(skipped)(deploy.id), "failed")
  assert.match(read(skipped)(smoke.id), /^missing result/)
  // A run that has not ended gives pending, outside the failed checks.
  const pending = { status: "in_progress", jobs: [] }
  assert.equal(read(pending)(deploy.id), "pending")
  assert.equal(read(pending)(smoke.id), "pending")
})

test("the project check times job selects the typecheck, lint and policy checks that can be cached", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const step = workflow
    .split("\n      - name: ")
    .find((part) => part.startsWith("Project checks through the check runner"))
  assert.ok(step, "the job has the check runner step")
  const filter = step.match(/jq -r '([^']*)'/)
  assert.ok(filter, "the step filters checks with jq")
  const listed = spawnSync("node", ["scripts/checks/list.mjs"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
  assert.equal(listed.status, 0, listed.stderr)
  const manifest = JSON.parse(listed.stdout)
  const selected = spawnSync("jq", ["-r", filter[1]], {
    input: listed.stdout,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
  assert.equal(selected.status, 0, selected.stderr)
  const ids = selected.stdout.split("\n").filter(Boolean)
  const expected = manifest.checks
    .filter(
      (c) =>
        ["typecheck", "lint", "policy"].includes(c.family) &&
        c.cacheable !== false,
    )
    .map((c) => c.id)
  assert.ok(
    manifest.checks.some((c) => c.cacheable === false && c.family === "policy"),
  )
  for (const family of ["typecheck", "lint", "policy"])
    assert.ok(
      ids.some((id) => id.startsWith(`${family}:`)),
      family,
    )
  assert.deepEqual(ids.sort(), expected.sort())
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
