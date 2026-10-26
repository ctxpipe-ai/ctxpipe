import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

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
  assert.equal(count("lint"), 3)
  assert.ok(count("policy") >= 8)
  assert.equal(count("eval", "mcp"), evalCaseCount())
  assert.equal(count("eval", "cli-memory"), 0)
  assert.equal(count("vitest", "latency"), 1)
  assert.equal(count("vitest", "upgrade"), 1)
  // The required golden stories are tagged (ci-storybook-golden.test.mjs),
  // so the golden lane holds at least them.
  assert.ok(count("storybook", "golden") >= requiredStories.length)
  assert.ok(count("storybook", "plays") > 0)
  // An expensive check states its intent in under about 40 words, and a
  // check that calls a model or a wall clock is stochastic.
  for (const check of manifest.checks) {
    const expensive =
      check.family === "eval" ||
      check.lane === "golden" ||
      check.lane === "latency" ||
      check.lane === "upgrade"
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
  const { markExitFailure } = await import("../checks/lanes.mjs")
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
  assert.match(
    markExitFailure(records, { status: null, signal: "SIGKILL" })[0].message,
    /SIGKILL/,
  )
})

test("an eval case verdict is the eval gate for that case", async () => {
  const { caseVerdict } = await import("../checks/evals.mjs")
  const run = (a, b) => ({ iterations: 3, passes: { m1: { x: a }, m2: { x: b } } })
  const baseline = {
    recordedAt: "",
    models: {
      m1: { aggregate: 1, cases: { x: 1 } },
      m2: { aggregate: 1, cases: { x: 1 } },
    },
  }
  const verdict = async (...args) => (await caseVerdict(...args)).cases.map((c) => c.status)
  assert.deepEqual(await verdict(run(3, 3), "x", baseline), ["passed", "passed"])
  // 2 of 3 is under the floor of the gate, and 3 of 3 is not required for 0.9.
  assert.deepEqual(await verdict(run(2, 3), "x", baseline), ["failed", "passed"])
  assert.deepEqual(await verdict(run(3, 3), "x", null), ["passed", "passed"])
  // One model is under the gate minimum of models.
  const single = await caseVerdict({ iterations: 3, passes: { m1: { x: 3 } } }, "x", null)
  assert.match(single.general.join(), /at least 2 models/)
})
