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

const root = fileURLToPath(new URL("../../", import.meta.url))
const script = (name) => join(root, "scripts/checks", name)
const schema = (name) =>
  JSON.parse(readFileSync(script(`schema/${name}.v1.schema.json`), "utf8"))
const node = (args, input) =>
  spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", input })

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
  if (rule.minimum !== undefined) assert.ok(value >= rule.minimum, path)
  if (rule.pattern) assert.match(value, new RegExp(rule.pattern), path)
  if (rule.type === "array") {
    assert.ok(Array.isArray(value), path)
    if (rule.minItems !== undefined) assert.ok(value.length >= rule.minItems, path)
    if (rule.maxItems !== undefined) assert.ok(value.length <= rule.maxItems, path)
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

test("the manifest matches its schema and has one check for each inventory file", () => {
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
    const files = manifest.checks.filter((check) => check.lane === lane)
    assert.equal(files.length, JSON.parse(inventory.stdout).length, lane)
  }
  for (const check of manifest.checks) {
    assert.equal(check.id, `vitest:${check.lane}:${check.file}`)
    assert.ok(existsSync(join(root, check.file)), check.file)
    assert.ok(existsSync(join(root, check.root, "package.json")), check.root)
    assert.ok(check.file.startsWith(`${check.root}/`), check.file)
    for (const input of check.inputs)
      assert.ok(
        existsSync(join(root, input.replace(/\/\*\*$/, ""))),
        `${check.lane}: ${input}`,
      )
  }
  assert.ok(manifest.checks.some((check) => check.lane === "codesearch"))
  assert.ok(manifest.checks.some((check) => check.lane === "codesearch-bun"))
  // A cache key hashes a `value` variable, and holds only set or unset for a
  // `presence` variable.
  const env = (lane) => manifest.checks.find((check) => check.lane === lane).env
  const mode = (lane, name) => env(lane).find((item) => item.name === name)?.mode
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
