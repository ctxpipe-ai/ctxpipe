import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  code,
  comment,
  decideMode,
  describe,
  marker,
  shadow,
  summary,
} from "../checks/gate.mjs"
import { suiteRecord } from "../checks/lanes.mjs"
import { schemaErrors } from "../checks/schema.mjs"
import { estimate, profileOf, shard, shardMinutes } from "../checks/shard.mjs"
import { hashed, toolchain } from "../checks/toolchain.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const sha = (n) => String(n).repeat(40).slice(0, 40)
const key = (n) => String(n).repeat(64).slice(0, 64)
const pinned = {
  mode: "shadow",
  factory: { version: sha(1), sha256: key(2) },
  acceptAgentResults: true,
}

test("only a same-repo pull_request without gate input changes runs the selector", () => {
  const mode = (overrides) =>
    decideMode({
      config: pinned,
      event: "pull_request",
      fork: false,
      changed: ["apps/ui/src/a.tsx", "apps/ui/package.json"],
      ...overrides,
    })
  assert.deepEqual(mode({}), { mode: "select", reason: "shadow" })
  assert.deepEqual(mode({ event: "schedule" }), {
    mode: "full",
    reason: "event schedule",
  })
  assert.deepEqual(mode({ fork: true }), { mode: "full", reason: "fork PR" })
  for (const path of [
    ".github/workflows/ci.yaml",
    ".github/merge-gate.json",
    "scripts/checks/gate.mjs",
    "scripts/ci/test-suite.mjs",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    ".node-version",
  ])
    assert.deepEqual(mode({ changed: ["apps/a.ts", path] }), {
      mode: "full",
      reason: `gate inputs changed: ${path}`,
    })
  assert.match(
    mode({ changed: Array.from({ length: 7 }, (_, i) => `.github/${i}`) })
      .reason,
    /: \.github\/0, .*\.github\/4 and 2 more$/,
  )
  assert.deepEqual(
    mode({ config: { ...pinned, factory: { version: null, sha256: null } } }),
    { mode: "full", reason: "selector unavailable: no pinned factory release" },
  )
  assert.equal(mode({ config: { ...pinned, mode: "off" } }).mode, "full")
})

test("the committed merge gate config is valid and in shadow mode", () => {
  const config = JSON.parse(
    readFileSync(join(root, ".github/merge-gate.json"), "utf8"),
  )
  assert.equal(config.mode, "shadow")
  assert.equal(config.acceptAgentResults, true)
  assert.ok(
    config.factory.version === null ||
      /^[0-9a-f]{40}$/.test(config.factory.version),
  )
})

const hit = (id, source, hostKind = "sandbox") => ({
  id,
  key: key(3),
  source,
  provenance: {
    hostKind,
    createdAt: "2026-10-26T10:00:00Z",
    commit: sha(4),
    dirty: false,
    factoryVersion: "0.1.0",
    inputs: { mode: "traced", files: 3, traceCommit: sha(5), toolchain: {} },
  },
})

// A record in the format of `factory check --json`.
const selection = (overrides = {}) => ({
  schemaVersion: 1,
  variant: "b",
  base: sha(6),
  trace: { commit: sha(7), checks: 787 },
  counts: {
    selected: 6,
    variantA: 30,
    total: 40,
    changed: 2,
    stochasticOmitted: 25,
  },
  selected: [
    {
      id: "vitest:ui:apps/ui/src/a.test.tsx",
      lane: "ui",
      file: "apps/ui/src/a.test.tsx",
      reason: {
        kind: "covers",
        path: "apps/ui/src/a.tsx",
        lines: [3, 9],
        chosen: 1,
        candidates: 2,
      },
    },
    {
      id: "vitest:backend:apps/backend/src/b.test.ts",
      lane: "backend",
      file: "apps/backend/src/b.test.ts",
      reason: { kind: "imports", chain: ["x.ts", "apps/backend/src/b.ts"] },
    },
    {
      id: "storybook:golden:apps/ui/src/c.stories.tsx#c--one",
      lane: "golden",
      file: "apps/ui/src/c.stories.tsx",
      reason: { kind: "changed" },
    },
    {
      id: "vitest:vercel:apps/backend/src/d.contract.test.ts",
      lane: "vercel",
      file: "apps/backend/src/d.contract.test.ts",
      reason: { kind: "input", input: "package.json", chain: [] },
    },
    {
      id: "lint:oxlint:.oxlintrc.json",
      lane: "oxlint",
      file: ".oxlintrc.json",
      reason: { kind: "input", input: "apps/**", chain: [] },
    },
    {
      id: "typecheck:ui:apps/ui/tsconfig.json",
      lane: "ui",
      file: "apps/ui/tsconfig.json",
      reason: { kind: "input", input: "apps/ui/**", chain: [] },
    },
  ],
  omitted: [
    {
      id: "vitest:backend:apps/backend/src/f.test.ts",
      lane: "backend",
      reason: "not reached",
    },
    {
      id: "vitest:backend:apps/backend/src/g.test.ts",
      lane: "backend",
      reason: "reached, but not needed to cover the changed lines",
    },
  ],
  degraded: false,
  untraced: [],
  notes: [
    `variant B: trace of commit ${sha(7).slice(0, 12)} (2 days old; 787 traced checks), k = 3`,
  ],
  timingsMs: { total: 2252 },
  cache: {
    shared: true,
    hits: [
      hit("storybook:golden:apps/ui/src/c.stories.tsx#c--one", "ci", "ci"),
      hit("vitest:vercel:apps/backend/src/d.contract.test.ts", "agent"),
      hit("lint:oxlint:.oxlintrc.json", "agent"),
    ],
    misses: [
      { id: "vitest:ui:apps/ui/src/a.test.tsx", key: key(8), mode: "traced" },
    ],
    unkeyed: [],
    notes: [],
    timingsMs: { inputs: 118, keys: 189, lookup: 40 },
  },
  ...overrides,
})

const needs = (overrides = {}) =>
  Object.fromEntries(
    Object.entries({
      "merge-gate-manifest": "success",
      "merge-gate-select": "success",
      lint: "success",
      typecheck: "success",
      "test-shards": "failure",
      "package-tests": "success",
      test: "failure",
      "production-builds": "success",
      packages: "success",
      "storybook-golden": "success",
      "storybook-plays": "success",
      codesearch: "success",
      "vercel-sandbox": "success",
      "terraform-validate": "success",
      migrate: "success",
      "upgrade-from-previous-release": "success",
      ...overrides,
    }).map(([name, result]) => [name, { result, outputs: {} }]),
  )

const records = [
  { id: "vitest:backend:apps/backend/src/b.test.ts", status: "failed" },
  { id: "vitest:backend:apps/backend/src/f.test.ts", status: "failed" },
  { id: "vitest:backend:apps/backend/src/f.test.ts", status: "passed" },
]

const jobs = {
  jobs: [
    ["Merge gate manifest", 0, 1],
    ["Merge gate selection", 1, 2],
    ["backend tests (shard 1/4)", 0, 12],
    ["contracts tests (shard 1/5)", 0, 8],
    ["Production build (ui)", 0, 2],
    ["Migrations (fresh schema)", 0, 1],
    ["Merge gate (shadow)", 12, null],
  ].map(([name, start, end]) => ({
    name,
    started_at: new Date(Date.UTC(2026, 9, 27, 10, start)).toISOString(),
    completed_at:
      end === null
        ? null
        : new Date(Date.UTC(2026, 9, 27, 10, end)).toISOString(),
  })),
}

function inputs(files) {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-merge-gate-"))
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(directory, name), JSON.stringify(value))
  return directory
}

const decide = (options = {}) =>
  shadow({
    config: pinned,
    inputs: inputs({
      "mode.json": { mode: "select", reason: "shadow" },
      "selection.json": selection(),
      ...options.files,
    }),
    records,
    needs: needs(options.needs),
    jobs,
    run: { id: "1", attempt: 1, pr: 7, sha: sha(9) },
    ...options.shadow,
  })

test("the gated verdict needs one accepted result for each selected check", () => {
  const decision = decide()
  assert.equal(decision.mode, "shadow")
  assert.equal(decision.fullRun.verdict, "fail")
  assert.equal(decision.gatedRun.verdict, "fail")
  assert.deepEqual(
    decision.ran.map(({ id, result }) => [id, result]),
    [
      ["vitest:ui:apps/ui/src/a.test.tsx", "passed"],
      ["vitest:backend:apps/backend/src/b.test.ts", "failed"],
      // An agent hit of the vercel lane is refused: its job sets lane
      // variables that the toolchain record does not hold.
      ["vitest:vercel:apps/backend/src/d.contract.test.ts", "passed"],
      ["typecheck:ui:apps/ui/tsconfig.json", "passed"],
    ],
  )
  assert.equal(decision.ran[2].refused, "agent")
  assert.deepEqual(
    decision.hits.map(({ id, class: kind }) => [id, kind]),
    [
      ["storybook:golden:apps/ui/src/c.stories.tsx#c--one", "ci"],
      ["lint:oxlint:.oxlintrc.json", "agent"],
    ],
  )
  assert.deepEqual(decision.hitClasses, { ci: 1, agent: 2 })
  assert.equal(decision.metrics.agreement, "agree")
  assert.deepEqual(decision.metrics.recall, {
    failed: 2,
    ran: 1,
    escaped: [
      {
        id: "vitest:backend:apps/backend/src/f.test.ts",
        why: "omitted: not reached",
      },
    ],
  })
  assert.deepEqual(decision.metrics.contradictions, [])
  assert.equal(decision.selection.traceAgeDays, 2)
  assert.deepEqual(decision.omitted, {
    byLane: {
      backend: {
        "not reached": 1,
        "reached, but not needed to cover the changed lines": 1,
      },
    },
    stochastic: 25,
  })
})

test("without acceptAgentResults an agent hit runs, and a failed hit is a contradiction", () => {
  const decision = decide({
    shadow: { config: { ...pinned, acceptAgentResults: false } },
    needs: { "storybook-golden": "failure" },
  })
  assert.deepEqual(
    decision.hits.map(({ id }) => id),
    ["storybook:golden:apps/ui/src/c.stories.tsx#c--one"],
  )
  assert.ok(decision.ran.some(({ id }) => id === "lint:oxlint:.oxlintrc.json"))
  // The golden job failed, so the story has no known result: not a
  // contradiction. A record that says failed is one.
  assert.deepEqual(decision.metrics.contradictions, [])
  const contradicted = shadow({
    config: pinned,
    inputs: inputs({
      "mode.json": { mode: "select", reason: "shadow" },
      "selection.json": selection(),
    }),
    records: [
      {
        id: "storybook:golden:apps/ui/src/c.stories.tsx#c--one",
        status: "failed",
      },
    ],
    needs: needs(),
    jobs,
    run: { id: "1", attempt: 1, pr: 7, sha: sha(9) },
  })
  assert.deepEqual(contradicted.metrics.contradictions, [
    { id: "storybook:golden:apps/ui/src/c.stories.tsx#c--one", class: "ci" },
  ])
})

test("a check without a record takes its job result, and an unknown result is not a pass", () => {
  const decision = decide({
    needs: { "test-shards": "success", test: "success", typecheck: "failure" },
    shadow: { records: [] },
  })
  assert.equal(
    decision.ran.find(({ id }) => id.startsWith("typecheck")).result,
    "unknown",
  )
  assert.equal(decision.gatedRun.verdict, "unknown")
  assert.equal(decision.metrics.agreement, "unknown")
})

test("an always-run job that fails fails the gated run", () => {
  const decision = decide({
    needs: { "test-shards": "success", test: "success", migrate: "failure" },
    shadow: { records: [] },
  })
  assert.equal(decision.gatedRun.verdict, "fail")
  assert.deepEqual(decision.gatedRun.failedAlwaysRun, ["migrate"])
})

test("every fallback gives a full run with the reason", () => {
  const full = (options) => {
    const decision = decide(options)
    assert.equal(decision.mode, "full")
    assert.equal(decision.gatedRun.verdict, decision.fullRun.verdict)
    return decision.reason
  }
  assert.equal(
    full({ files: { "mode.json": { mode: "full", reason: "fork PR" } } }),
    "fork PR",
  )
  assert.equal(
    full({ needs: { "merge-gate-select": "failure" } }),
    "selector unavailable: select job failure",
  )
  assert.match(
    full({ files: { "selection.json": selection({ schemaVersion: 2 }) } }),
    /^selector unavailable: the record does not match the schema \(\$\.schemaVersion/,
  )
  assert.equal(
    shadow({
      config: pinned,
      inputs: inputs({}),
      records: [],
      needs: needs({ "merge-gate-manifest": "failure" }),
      jobs,
      run: {},
    }).reason,
    "manifest job failure",
  )
})

test("the cost compares the measured full run with the estimated gated run", () => {
  const { cost } = decide().metrics
  // Full run: every job but the merge gate jobs.
  assert.equal(cost.fullRunMinutes, 23)
  assert.equal(cost.parts.manifestAndSelect, 2)
  // Production build and migrations, and the CI script tests.
  assert.equal(cost.parts.alwaysRun, 3.7)
  assert.deepEqual(Object.keys(cost.shards).sort(), [
    "database",
    "node",
    "project",
    "vercel",
  ])
  assert.ok(cost.gatedRunMinutes < cost.fullRunMinutes)
  assert.equal(cost.fullRunWallMinutes, 12)
})

test("the published text escapes PR values and names no writer", () => {
  const evil = "apps/ui/src/x|<img src=x>`@team‮\n::error::bad.test.tsx"
  const base = selection()
  base.selected[0].id = evil
  base.cache.hits[0].provenance.who = "email-sha256:0123456789abcdef"
  const decision = decide({ files: { "selection.json": base } })
  const text = summary(decision, "https://example.com/run")
  assert.ok(text.includes(code(evil)))
  // A code span shows HTML as text; the value cannot close the span.
  assert.match(text, /`[^`\n]*<img[^`\n]*`/)
  assert.ok(!/^::/m.test(text))
  assert.ok(!text.includes("‮"))
  assert.ok(!text.includes("email-sha256"))
  const note = comment(decision, "https://example.com/run")
  assert.ok(note.startsWith(`${marker}\n`))
  assert.ok(!note.includes("email-sha256"))
  assert.match(note, /Gated run would: \*\*fail\*\*/)
  assert.equal(code("a`b|c"), "`a'b\\|c`")
})

test("each selection reason has one line", () => {
  assert.equal(
    describe({
      kind: "covers",
      path: "a.ts",
      lines: [1, 4],
      chosen: 1,
      candidates: 9,
    }),
    "covers a.ts:1-4 (1 of 9)",
  )
  assert.equal(
    describe({ kind: "imports", chain: ["t", "b.ts"] }),
    "imports b.ts",
  )
  assert.equal(describe({ kind: "newKind" }), "newKind")
})

test("the shards of each profile hold about five minutes, up to today's shard count", () => {
  const seconds = new Map([
    ["vitest:backend:apps/backend/a.test.ts", 200],
    ["vitest:backend:apps/backend/b.test.ts", 200],
    ["vitest:contracts:apps/backend/c.test.ts", 200],
    ["vitest:ui:apps/ui/d.test.tsx", 5],
    ["vitest:ui:apps/ui/e.test.tsx", 5],
  ])
  const shards = shard([...seconds.keys(), "eval:mcp:x#y"], seconds, {})
  assert.deepEqual(Object.keys(shards), ["database", "node"])
  assert.equal(shards.database.length, 2)
  assert.deepEqual(
    shards.database.map((item) => item.seconds),
    [400, 200],
  )
  assert.equal(shards.node.length, 1)
  const many = new Map(
    Array.from({ length: 40 }, (_, i) => [
      `vitest:ui:apps/ui/${i}.test.tsx`,
      100,
    ]),
  )
  assert.equal(shard([...many.keys()], many, {}).node.length, 1)
  assert.equal(shardMinutes({ node: [{ ids: [], seconds: 60 }] }), 1.3)
  assert.equal(profileOf("eval:mcp:x"), undefined)
  assert.equal(profileOf("vitest:latency:x"), undefined)
  assert.equal(
    profileOf("policy:runners:scripts/ci/check-runners.mjs"),
    "project",
  )
  assert.equal(
    estimate("vitest:backend:apps/backend/src/x.test.ts", new Map(), {
      backend: { "src/x.test.ts": 42 },
    }),
    42,
  )
  assert.equal(
    estimate("typecheck:ui:apps/ui/tsconfig.json", new Map(), {}),
    60,
  )
})

test("the toolchain record hashes each value and matches its schema", () => {
  const manifest = {
    checks: [
      { env: [{ name: "MODEL_PROVIDER", mode: "value" }] },
      { env: [{ name: "GITHUB_TOKEN", mode: "presence" }] },
    ],
  }
  const record = toolchain(
    manifest,
    { MODEL_PROVIDER: "openrouter", TZ: "UTC" },
    (tool) => (tool === "pnpm" ? "10.12.1" : undefined),
  )
  assert.deepEqual(Object.keys(record.env), [
    "GITHUB_TOKEN",
    "MODEL_PROVIDER",
    "NODE_OPTIONS",
    "TZ",
  ])
  assert.equal(record.env.GITHUB_TOKEN, "unset")
  assert.equal(record.env.MODEL_PROVIDER, hashed("openrouter"))
  assert.match(hashed("openrouter"), /^sha256:[0-9a-f]{16}$/)
  assert.ok(!JSON.stringify(record).includes("openrouter"))
  assert.equal(record.bun, undefined)
  assert.ok(["linux", "macos"].includes(record.os))
  assert.ok(["x86_64", "aarch64"].includes(record.arch))
  assert.deepEqual(schemaErrors(record, "toolchain.v1"), [])
  assert.notDeepEqual(
    schemaErrors({ ...record, env: { TZ: "UTC" } }, "toolchain.v1"),
    [],
  )
})

test("a selection record of the factory format matches its schema", () => {
  assert.deepEqual(schemaErrors(selection(), "selection.v1"), [])
  const bad = selection()
  bad.cache.hits[0].source = "s3"
  assert.match(schemaErrors(bad, "selection.v1")[0], /source: is not one of/)
  assert.match(
    schemaErrors(
      { ...selection(), selected: [{ id: "x" }] },
      "selection.v1",
    )[0],
    /has no lane/,
  )
})

test("a Vitest suite gives one result record", () => {
  const suite = (statuses) => ({
    startTime: 10,
    endTime: 30,
    message: "",
    assertionResults: statuses.map((status, i) => ({
      fullName: `case ${i}`,
      status,
      duration: 1,
    })),
  })
  assert.equal(suiteRecord("a", suite(["passed", "pending"])).status, "passed")
  assert.equal(suiteRecord("a", suite(["passed", "failed"])).status, "failed")
  assert.equal(suiteRecord("a", suite(["skipped"])).status, "skipped")
  assert.equal(suiteRecord("a", undefined).status, "error")
  assert.equal(suiteRecord("a", suite(["passed"])).durationMs, 20)
  assert.deepEqual(
    schemaErrors(
      { schemaVersion: 1, ...suiteRecord("a", suite(["failed"])) },
      "result.v1",
    ),
    [],
  )
})

test("the CLI writes the decision files from artifacts", () => {
  const directory = inputs({
    "mode.json": { mode: "select", reason: "shadow" },
    "selection.json": selection(),
  })
  const results = join(directory, "results", "test-results-backend-1")
  mkdirSync(results, { recursive: true })
  writeFileSync(
    join(results, "records.ndjson"),
    `${JSON.stringify({ schemaVersion: 1, id: "vitest:backend:apps/backend/src/b.test.ts", status: "failed", durationMs: 1, cases: [] })}\n`,
  )
  writeFileSync(join(directory, "needs.json"), JSON.stringify(needs()))
  writeFileSync(join(directory, "config.json"), JSON.stringify(pinned))
  const out = join(directory, "out")
  const run = spawnSync(
    process.execPath,
    [
      join(root, "scripts/checks/gate.mjs"),
      "shadow",
      "--config",
      join(directory, "config.json"),
      "--inputs",
      directory,
      "--results",
      join(directory, "results"),
      "--needs",
      join(directory, "needs.json"),
      "--out",
      out,
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  )
  assert.equal(run.status, 0, run.stderr)
  const decision = JSON.parse(readFileSync(join(out, "decision.json"), "utf8"))
  assert.equal(decision.gatedRun.verdict, "fail")
  assert.ok(
    readFileSync(join(out, "summary.md"), "utf8").includes(
      "## Merge gate (shadow)",
    ),
  )
  assert.ok(readFileSync(join(out, "comment.md"), "utf8").startsWith(marker))
})
