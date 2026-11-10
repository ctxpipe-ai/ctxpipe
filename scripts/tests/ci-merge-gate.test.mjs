import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
  code,
  comment,
  critics,
  criticsFail,
  criticsText,
  decideMode,
  describe,
  marker,
  shadow,
  summary,
} from "../checks/gate.mjs"
import { suiteRecord } from "../checks/lanes.mjs"
import { schemaErrors } from "../checks/schema.mjs"
import {
  checkJobs,
  estimate,
  profiles,
  runsInOf,
  shard,
  shardMinutes,
  shardTargetSeconds,
  storybookBuildMinutes,
} from "../checks/shard.mjs"
import { hashed, programVersion, toolchain } from "../checks/toolchain.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const sha = (n) => String(n).repeat(40).slice(0, 40)
const key = (n) => String(n).repeat(64).slice(0, 64)
const pinned = {
  mode: "shadow",
  factory: { version: sha(1), sha256: key(2) },
  acceptAgentResults: true,
}

// The files that list.mjs runs or imports at list time, from the static
// import closure of list.mjs: a relative `from "x"` or `import("x")`, a script
// that a `json("x")` call spawns, and a file that a `readFileSync(join(root, "x"))` read opens.
function listTimeFiles() {
  const seen = new Set()
  const visit = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    if (!/\.(?:mjs|ts)$/.test(file)) return
    const text = readFileSync(join(root, file), "utf8")
    const found = [
      ...[...text.matchAll(/(?:from\s+|import\()\s*["'](\.[^"']+)["']/g)].map(
        (match) => relative(root, resolve(root, dirname(file), match[1])),
      ),
      ...[
        ...text.matchAll(
          /(?:json\(|readFileSync\(\s*join\(root,\s*)"([^"]+\.(?:mjs|json))"/g,
        ),
      ].map((match) => match[1]),
    ]
    for (const path of found)
      for (const candidate of [path, `${path}.ts`, `${path}.mjs`])
        if (existsSync(join(root, candidate))) {
          visit(candidate)
          break
        }
  }
  visit("scripts/checks/list.mjs")
  return [...seen]
}

test("a file that list.mjs runs outside scripts/checks forces a full run", () => {
  const files = listTimeFiles()
  // The walk finds the known files, so a broken walk cannot pass.
  for (const known of [
    "scripts/checks/families.mjs",
    "apps/backend/evals/mcp/cases.ts",
    "apps/ui/.storybook/check-modules.mjs",
    "apps/codesearch/scripts/run-vitest-contracts.mjs",
    "scripts/ci/projects.json",
  ])
    assert.ok(files.includes(known), `walk reaches ${known}`)
  const outside = files.filter((file) => !file.startsWith("scripts/checks/"))
  for (const file of [...outside, ".npmrc"])
    if (existsSync(join(root, file)))
      assert.equal(
        decideMode({
          config: pinned,
          event: "pull_request",
          fork: false,
          changed: [file],
        }).mode,
        "full",
        file,
      )
})

test("only a same-repo pull_request without gate input changes runs the selector", () => {
  const mode = (overrides) =>
    decideMode({
      config: pinned,
      event: "pull_request",
      fork: false,
      changed: ["apps/ui/src/a.tsx", "apps/ui/README.md"],
      ...overrides,
    })
  assert.deepEqual(mode({}), { mode: "select", reason: "shadow" })
  assert.deepEqual(mode({ event: "schedule" }), {
    mode: "full",
    reason: "event schedule",
  })
  assert.deepEqual(mode({ fork: true }), { mode: "full", reason: "fork PR" })
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/ui/package.json",
    "packages/cli/package.json",
  ])
    assert.deepEqual(mode({ changed: [path] }), {
      mode: "select",
      reason: "shadow",
    })
  for (const path of [
    ".github/merge-gate.json",
    "scripts/checks/gate.mjs",
    "scripts/checks/schema/result.v1.schema.json",
    ".github/actions/setup/action.yml",
    "scripts/ci/test-suite.mjs",
    "scripts/ci/vitest-launch.mjs",
    ".npmrc",
    "patches/a.patch",
  ])
    assert.deepEqual(mode({ changed: ["apps/a.ts", path] }), {
      mode: "full",
      reason: `gate inputs changed: ${path}`,
    })
  for (const path of [
    ".github/workflows/deploy.yaml",
    ".github/workflows/pr-deploy.yaml",
    ".github/workflows/observability.yaml",
    ".github/workflows/terraform-plan-pr.yaml",
    "scripts/checks/README.md",
    ".node-version",
    "scripts/ci/check-secret-jobs.mjs",
  ])
    assert.equal(mode({ changed: ["apps/a.ts", path] }).mode, "select", path)
  assert.match(
    mode({
      changed: Array.from({ length: 7 }, (_, i) => `.github/actions/${i}`),
    }).reason,
    /: \.github\/actions\/0, .*\.github\/actions\/4 and 2 more$/,
  )
  assert.deepEqual(
    mode({ config: { ...pinned, factory: { version: null, sha256: null } } }),
    { mode: "full", reason: "selector unavailable: no pinned factory release" },
  )
  assert.equal(mode({ config: { ...pinned, mode: "off" } }).mode, "full")
  // Both the shadow and the gate mode select.
  assert.deepEqual(mode({ config: { ...pinned, mode: "gate" } }), {
    mode: "select",
    reason: "gate",
  })
})

// The text of one job of a workflow, from its key to the next job.
const workflowJob = (workflow, name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  assert.ok(start > 0, name)
  return workflow.slice(start, workflow.indexOf("\n\n  ", start + 1))
}

test("a ci.yaml change only in the steps of check jobs runs the selector with those jobs", () => {
  const path = ".github/workflows/ci.yaml"
  const base = readFileSync(join(root, path), "utf8")
  // The hunks come from git, as in CI: `git diff -U0` of the two sides.
  const mode = (head, changed = [path]) => {
    const directory = mkdtempSync(join(tmpdir(), "ctxpipe-ci-yaml-"))
    writeFileSync(join(directory, "base"), base)
    writeFileSync(join(directory, "head"), head)
    return decideMode({
      config: pinned,
      event: "pull_request",
      fork: false,
      changed,
      read: (_, side) => (side === "base" ? base : head),
      diff: () =>
        spawnSync("git", ["diff", "--no-index", "-U0", "base", "head"], {
          cwd: directory,
          encoding: "utf8",
        }).stdout,
    })
  }
  const lintStep = base.replace(
    "      - run: pnpm lint\n",
    "      - run: pnpm lint\n      - run: pnpm lint:extra\n",
  )
  assert.deepEqual(mode(lintStep), {
    mode: "select",
    reason: "shadow",
    jobs: ["lint"],
  })
  assert.deepEqual(
    mode(
      lintStep.replace(
        "run: node --test apps/codesearch/scripts/fetch-releases.test.mjs",
        "run: node --test apps/codesearch/scripts/*.test.mjs",
      ),
    ).jobs,
    ["codesearch", "lint"],
  )
  const full = { mode: "full", reason: `gate inputs changed: ${path}` }
  // A hunk before `jobs:`.
  assert.deepEqual(mode(base.replace("name: CI\n", "name: CI checks\n")), full)
  // A merge gate job.
  assert.deepEqual(
    mode(base.replace("did not finish in 3 minutes", "did not finish")),
    full,
  )
  // A job that runs no check, and a job `name`.
  assert.deepEqual(
    mode(base.replace('echo "Test shards:', 'echo "Shards:')),
    full,
  )
  assert.deepEqual(
    mode(base.replace("name: Lint and format\n", "name: Lint\n")),
    full,
  )
  // A `needs` line of a check job.
  assert.deepEqual(
    mode(
      base.replace(
        "    needs: [merge-gate-plan, storybook-build]\n",
        "    needs: [merge-gate-plan, storybook-build, lint]\n",
      ),
    ),
    full,
  )
  // A step or a job that only a full run uses: a gated run would skip it.
  const once = (from, to) => {
    assert.equal(base.split(from).length, 2, from)
    return base.replace(from, to)
  }
  for (const head of [
    once(
      `node scripts/ci/test-suite.mjs \${{ matrix.lane }} --shard`,
      `node scripts/ci/test-suite.mjs \${{ matrix.lane }} --bail --shard`,
    ),
    once(
      "node scripts/ci/test-suite.mjs ui $(",
      "node scripts/ci/test-suite.mjs ui --bail $(",
    ),
    once(
      "      - name: UI tests\n",
      "      - name: UI tests\n        timeout-minutes: 20\n",
    ),
  ])
    assert.deepEqual(mode(head), full)
  const requiredJob = workflowJob(base, "storybook-required")
  assert.deepEqual(
    mode(
      base.replace(
        requiredJob,
        requiredJob.replace(/\n {6}- /, "\n      - run: true\n      - "),
      ),
    ),
    full,
  )
  // The gated step of the same job stays scoped.
  assert.deepEqual(
    mode(
      once(
        "      - name: Selected UI, CLI and CDK tests (merge gate)\n",
        "      - name: Selected UI, CLI and CDK tests (merge gate)\n        timeout-minutes: 20\n",
      ),
    ).jobs,
    ["package-tests"],
  )
  // A changed action is a gate input of its own.
  assert.deepEqual(mode(lintStep, [path, ".github/actions/a/action.yml"]), {
    mode: "full",
    reason: `gate inputs changed: ${path}, .github/actions/a/action.yml`,
  })
})

test("each mode or lane condition of a check job has a form that the full-run rule reads", () => {
  // gate.mjs finds a step or job that only a full run uses by its text. A
  // new form of condition must get a rule there first, then a place here.
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const known = new Set([
    "needs.merge-gate-plan.outputs.mode != 'gate'",
    "needs.merge-gate-plan.outputs.mode == 'gate'",
    "matrix.lane != 'selected'",
    "matrix.lane == 'selected'",
    // A step that runs in each mode: the selected lane is not backend.
    "matrix.lane != 'backend'",
  ])
  for (const name of [...checkJobs, "storybook-build"].filter((job) =>
    workflow.includes(`\n  ${job}:\n`),
  )) {
    const text = workflowJob(workflow, name).replace(/\n\s*#[^\n]*/g, "")
    for (const [atom] of text.matchAll(
      /[\w.-]*(?:outputs\.mode|matrix\.lane)\b(?:\s*[!=]=\s*'[^']*')?/g,
    ))
      if (!/^\S*matrix\.lane$/.test(atom) || /[!=]=/.test(atom))
        assert.ok(known.has(atom), `${name}: ${atom}`)
    // The job form `mode != 'gate' || <its output> != ''` runs in a gated
    // run; any other alternative would hide a full-run-only job.
    for (const [, rest] of text.matchAll(/mode != 'gate' \|\|([^)]*)\)/g))
      assert.match(
        rest,
        /^ needs\.merge-gate-plan\.outputs\.[\w-]+ != ''$/,
        name,
      )
    assert.equal(
      (text.match(/mode != 'gate' \|\|/g) ?? []).length,
      [
        ...text.matchAll(
          /\(needs\.merge-gate-plan\.outputs\.mode != 'gate' \|\|/g,
        ),
      ].length,
      name,
    )
  }
})

test("the checks of the jobs of a job-scoped ci.yaml change run, without their hits", () => {
  const decision = decide({
    files: {
      "mode.json": {
        mode: "select",
        reason: "shadow",
        jobs: ["lint", "test-shards"],
      },
    },
  })
  const ran = Object.fromEntries(
    decision.ran.map((item) => [item.id, item.reason]),
  )
  assert.equal(ran["lint:oxlint:.oxlintrc.json"], "lane input apps/**")
  assert.equal(
    ran["vitest:backend:apps/backend/src/f.test.ts"],
    "ci.yaml changed in job lint, test-shards",
  )
  assert.ok("vitest:backend:apps/backend/src/g.test.ts" in ran)
  assert.deepEqual(
    decision.hits.map((item) => item.id),
    ["storybook:required:apps/ui/src/c.stories.tsx#c--one"],
  )
  assert.equal(decision.selection.counts.selected, 8)
})

test("the committed merge gate config is valid and in gate mode", () => {
  const config = JSON.parse(
    readFileSync(join(root, ".github/merge-gate.json"), "utf8"),
  )
  assert.equal(config.mode, "gate")
  assert.equal(config.acceptAgentResults, true)
  assert.equal(config.acceptPrResults, true)
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
      id: "storybook:required:apps/ui/src/c.stories.tsx#c--one",
      lane: "required",
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
      hit("storybook:required:apps/ui/src/c.stories.tsx#c--one", "ci", "ci"),
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
      "storybook-required": "success",
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
  { id: "vitest:ui:apps/ui/src/a.test.tsx", status: "passed" },
  { id: "vitest:vercel:apps/backend/src/d.contract.test.ts", status: "passed" },
  { id: "typecheck:ui:apps/ui/tsconfig.json", status: "passed" },
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
      ["storybook:required:apps/ui/src/c.stories.tsx#c--one", "ci"],
      ["lint:oxlint:.oxlintrc.json", "agent"],
    ],
  )
  assert.deepEqual(decision.hitClasses, { ci: 1, agent: 2 })
  assert.equal(decision.metrics.selectionAgreement, "agree")
  assert.equal(decision.metrics.overallAgreement, "agree")
  assert.deepEqual(decision.metrics.flakyJobs, [])
  assert.deepEqual(decision.metrics.recall, {
    failed: 2,
    ran: 1,
    escaped: [
      {
        id: "vitest:backend:apps/backend/src/f.test.ts",
        why: "omitted: not reached",
      },
    ],
    // Hits and omitted checks without a record: reported, not counted.
    unverified: [
      {
        id: "lint:oxlint:.oxlintrc.json",
        result: "missing result (job lint: success)",
      },
      {
        id: "storybook:required:apps/ui/src/c.stories.tsx#c--one",
        result: "missing result (job storybook-required: success)",
      },
      {
        id: "vitest:backend:apps/backend/src/g.test.ts",
        result: "missing result (job test-shards: failure)",
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
    needs: { "storybook-required": "failure" },
  })
  assert.deepEqual(
    decision.hits.map(({ id }) => id),
    ["storybook:required:apps/ui/src/c.stories.tsx#c--one"],
  )
  assert.ok(decision.ran.some(({ id }) => id === "lint:oxlint:.oxlintrc.json"))
  // The required job failed, so the story has no known result: not a
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
        id: "storybook:required:apps/ui/src/c.stories.tsx#c--one",
        status: "failed",
      },
    ],
    needs: needs(),
    jobs,
    run: { id: "1", attempt: 1, pr: 7, sha: sha(9) },
  })
  assert.deepEqual(contradicted.metrics.contradictions, [
    { id: "storybook:required:apps/ui/src/c.stories.tsx#c--one", class: "ci" },
  ])
})

test("a selected check without a result is a missing result, and the gated run fails", () => {
  const decision = decide({
    needs: { "test-shards": "success", test: "success" },
    shadow: {
      records: records.filter(({ id }) => !id.startsWith("typecheck")),
    },
  })
  assert.equal(
    decision.ran.find(({ id }) => id.startsWith("typecheck")).result,
    "missing result (job typecheck: success)",
  )
  assert.equal(decision.gatedRun.verdict, "fail")
  // The full run passed: only the gated run fails.
  assert.equal(decision.fullRun.verdict, "pass")
  assert.equal(decision.metrics.overallAgreement, "false failure")
})

test("a selected check with an error or no record counts as a full-run failure in the recall", () => {
  const passed = records.map((record) => ({ ...record, status: "passed" }))
  const decisionWith = (changed) =>
    decide({
      needs: { "test-shards": "success", test: "success" },
      shadow: {
        records: passed
          .filter(
            ({ id }) => changed !== "missing" || !id.startsWith("typecheck"),
          )
          .map((record) =>
            changed === "error" && record.id.startsWith("typecheck")
              ? { ...record, status: "error" }
              : record,
          )
          .concat(
            // The omitted check errored, and the hit has no record.
            [
              {
                id: "vitest:backend:apps/backend/src/g.test.ts",
                status: "error",
              },
            ],
          ),
      },
    })
  for (const changed of ["error", "missing"]) {
    const decision = decisionWith(changed)
    assert.equal(decision.gatedRun.verdict, "fail")
    assert.equal(decision.metrics.recall.failed, 1)
    assert.equal(decision.metrics.recall.ran, 1)
    assert.deepEqual(decision.metrics.recall.escaped, [])
    // The full run did not prove the check either: the selection agrees.
    assert.equal(decision.metrics.selectionAgreement, "agree")
    assert.deepEqual(
      decision.metrics.recall.unverified.map(({ id, result }) => [id, result]),
      [
        ["lint:oxlint:.oxlintrc.json", "missing result (job lint: success)"],
        [
          "storybook:required:apps/ui/src/c.stories.tsx#c--one",
          "missing result (job storybook-required: success)",
        ],
        ["vitest:backend:apps/backend/src/g.test.ts", "error"],
      ],
    )
    const text = summary(decision)
    assert.match(
      text,
      /Omitted or hit checks that the full run did not prove: 3\./,
    )
    assert.match(text, /Not proved by the full run/)
  }
})

test("the agreement metrics count a cancelled run apart and name the flaky jobs", () => {
  const cancelled = decide({ needs: { codesearch: "cancelled" } })
  assert.equal(cancelled.metrics.selectionAgreement, "cancelled")
  assert.equal(cancelled.metrics.overallAgreement, "cancelled")
  const passing = records.map((record) => ({ ...record, status: "passed" }))
  const escape = decide({
    shadow: {
      records: [
        ...passing,
        { id: "vitest:backend:apps/backend/src/f.test.ts", status: "failed" },
      ],
    },
  })
  assert.equal(escape.metrics.selectionAgreement, "escape")
  assert.equal(escape.metrics.overallAgreement, "escape")
  // Only an always-run job fails: both runs fail, and no check fails.
  const always = decide({
    needs: { "test-shards": "success", test: "success", packages: "failure" },
    shadow: { records: passing },
  })
  assert.equal(always.metrics.selectionAgreement, "agree")
  assert.equal(always.metrics.overallAgreement, "agree")
  const rerun = decide({
    shadow: {
      jobs: { jobs: [{ name: "Typecheck", conclusion: "success" }] },
      earlier: {
        jobs: [
          { name: "Typecheck", conclusion: "failure" },
          { name: "Lint and format", conclusion: "failure" },
        ],
      },
    },
  })
  assert.deepEqual(rerun.metrics.flakyJobs, ["Typecheck"])
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
  // The select job names the exact cause.
  const cause = inputs({ "mode.json": { mode: "select", reason: "shadow" } })
  writeFileSync(
    join(cause, "select-cause.txt"),
    "the selector release does not match the pinned SHA-256\n",
  )
  assert.equal(
    shadow({
      config: pinned,
      inputs: cause,
      records: [],
      needs: needs({ "merge-gate-select": "failure" }),
      jobs,
      run: {},
    }).reason,
    "selector unavailable: the selector release does not match the pinned SHA-256",
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

test("a gated run packs its checks into the fewest shards that hold the target, up to today's shard count", () => {
  assert.equal(shardTargetSeconds, 600)
  // A few short checks: one shard for each profile.
  const seconds = new Map([
    ["vitest:backend:apps/backend/a.test.ts", 200],
    ["vitest:backend:apps/backend/b.test.ts", 150],
    ["vitest:contracts:apps/backend/c.test.ts", 100],
    ["vitest:ui:apps/ui/d.test.tsx", 5],
    ["vitest:ui:apps/ui/e.test.tsx", 5],
  ])
  const shards = shard([...seconds.keys(), "eval:mcp:x#y"], seconds, {})
  assert.deepEqual(Object.keys(shards), ["database", "node"])
  assert.deepEqual(
    shards.database.map((item) => item.seconds),
    [450],
  )
  assert.equal(shards.node.length, 1)
  // Long checks spread over today's shard count, and no more.
  const long = new Map(
    Array.from({ length: 30 }, (_, i) => [
      `vitest:backend:apps/backend/${i}.test.ts`,
      300,
    ]),
  )
  const spread = shard([...long.keys()], long, {})
  assert.equal(spread.database.length, profiles.database.maxShards)
  // Longest first to the least-loaded shard: the shards are balanced.
  const mixed = new Map(
    [500, 400, 300, 300, 200, 200, 100].map((value, i) => [
      `vitest:backend:apps/backend/m${i}.test.ts`,
      value,
    ]),
  )
  const balanced = shard([...mixed.keys()], mixed, {}).database
  assert.deepEqual(
    balanced.map((item) => item.seconds),
    [500, 500, 500, 500],
  )
  // Two long checks that fit the target in total, but not in one shard.
  const pair = new Map([
    ["vitest:backend:apps/backend/p.test.ts", 590],
    ["vitest:backend:apps/backend/q.test.ts", 20],
  ])
  assert.equal(shard([...pair.keys()], pair, {}).database.length, 2)
  // A check that alone is over the target gets no extra shards.
  const alone = new Map(
    [900, 100, 100, 100].map((value, i) => [
      `vitest:backend:apps/backend/r${i}.test.ts`,
      value,
    ]),
  )
  assert.deepEqual(
    shard([...alone.keys()], alone, {}).database.map((item) => item.seconds),
    [900, 300],
  )
  // A check without a trace duration or a file weight gets the median of
  // its traced lane.
  assert.equal(
    estimate("vitest:backend:apps/backend/new.test.ts", mixed, {}),
    300,
  )
  const many = new Map(
    Array.from({ length: 40 }, (_, i) => [
      `vitest:ui:apps/ui/${i}.test.tsx`,
      100,
    ]),
  )
  assert.equal(shard([...many.keys()], many, {}).node.length, 1)
  assert.equal(shardMinutes({ node: [{ ids: [], seconds: 60 }] }), 1.3)
  assert.equal(runsInOf("eval:mcp:x"), undefined)
  assert.equal(runsInOf("vitest:latency:x"), undefined)
  assert.deepEqual(runsInOf("policy:runners:scripts/ci/check-runners.mjs"), {
    job: "lint",
    profile: "project",
  })
  assert.deepEqual(runsInOf("storybook:required:x"), {
    job: "storybook-required",
    profile: "storybook",
  })
  assert.deepEqual(runsInOf("storybook:plays:x"), {
    job: "storybook-plays",
    profile: "storybook",
  })
  assert.deepEqual(runsInOf("storybook:visual:x"), {
    job: "storybook-visual",
    profile: "visual",
  })
  // A screenshot check counts 2 seconds, not the play time that the trace
  // holds for it.
  assert.equal(
    estimate("storybook:visual:a#x", new Map([["storybook:visual:a#x", 0.2]]), {}),
    2,
  )
  // Two short screenshot checks fit in one shard; the shards need the
  // Storybook build too. A selection of about 900 stories (2 seconds each)
  // takes 3 shards of the 10-minute target, under the 4 of a full run.
  assert.equal(
    shard(["storybook:visual:a#x", "storybook:visual:b#y"], new Map(), {})
      .visual.length,
    1,
  )
  assert.equal(
    shard(
      Array.from({ length: 900 }, (_, n) => `storybook:visual:a#s${n}`),
      new Map(
        Array.from({ length: 900 }, (_, n) => [`storybook:visual:a#s${n}`, 3]),
      ),
      {},
    ).visual.length,
    3,
  )
  assert.equal(
    shardMinutes({ visual: [{ ids: [], seconds: 60 }] }),
    Math.round((profiles.visual.setupMinutes + 1 + storybookBuildMinutes) * 10) /
      10,
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

test("the toolchain record holds the version of each host program that a check declares", () => {
  const outputs = {
    "git --version": "git version 2.50.1 (Apple Git-155)\n",
    'go version -m "$(command -v zoekt-webserver)"':
      "/x/zoekt-webserver: go1.24.1\n\tpath\tgithub.com/sourcegraph/zoekt/cmd/zoekt-webserver\n\tmod\tgithub.com/sourcegraph/zoekt\tv0.0.0-20250925130127-596c362fcf13\th1:abc=\n",
  }
  const asked = []
  const record = toolchain(
    {
      checks: [
        { programs: ["git"] },
        { programs: ["git", "zoekt", "ast-grep"] },
      ],
    },
    {},
    (tool) => (tool === "pnpm" ? "10.12.1" : undefined),
    (command) => {
      asked.push(command)
      return outputs[command]
    },
  )
  // ast-grep is not installed, so it is absent and its checks get no key.
  assert.deepEqual(record.programs, {
    git: "2.50",
    zoekt: "v0.0.0-20250925130127-596c362fcf13",
  })
  assert.equal(asked.length, 3)
  assert.deepEqual(schemaErrors(record, "toolchain.v1"), [])
  assert.notDeepEqual(
    schemaErrors({ ...record, programs: { curl: "8.0.0" } }, "toolchain.v1"),
    [],
  )
  assert.equal(programVersion("ast-grep", "ast-grep 0.45.0\n"), "0.45.0")
  assert.equal(programVersion("git", "no version"), undefined)
  assert.equal(
    programVersion("container-platform", "linux-arm64\n"),
    "linux-arm64",
  )
  assert.equal(programVersion("container-platform", ""), undefined)
  assert.throws(
    () => toolchain({ checks: [{ programs: ["curl"] }] }, {}, () => "1"),
    /unknown program curl/,
  )
  const none = toolchain(
    { checks: [{}] },
    {},
    () => "1",
    () => "",
  )
  assert.equal(none.programs, undefined)
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
  assert.equal(suiteRecord("a", undefined).origin, "runner")
  // A suite that threw at load is in the report: its fault, so no origin.
  const loadError = { ...suite([]), message: "Cannot find module" }
  assert.equal(suiteRecord("a", loadError).status, "error")
  assert.equal(suiteRecord("a", loadError).origin, undefined)
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
      "decide",
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

test("a critic with no stored verdict fails the gate, and the comment links each verdict", () => {
  const verdict = {
    commit: sha(7),
    createdAt: "2026-11-04T10:00:00Z",
    source: "agent",
  }
  const record = (status) => ({
    pr: "o/r#1",
    head: sha(8),
    critics: [
      {
        critic: "critic:spec",
        status: "carried",
        reason: "2 passes",
        verdicts: [verdict],
      },
      {
        critic: "critic:security",
        status,
        reason:
          "1 of 1 diffs have no stored verdict; run `factory check` on the branch head",
        verdicts: [],
      },
    ],
  })
  const decideWith = (mode, files) => {
    const directory = inputs({
      "mode.json": { mode: "select", reason: "shadow" },
      "selection.json": selection(),
      ...files,
    })
    const passing = Object.fromEntries(
      Object.keys(needs()).map((name) => [name, "success"]),
    )
    writeFileSync(join(directory, "needs.json"), JSON.stringify(passing))
    writeFileSync(
      join(directory, "config.json"),
      JSON.stringify({ ...pinned, mode }),
    )
    const out = join(directory, "out")
    const run = spawnSync(
      process.execPath,
      [
        join(root, "scripts/checks/gate.mjs"),
        "decide",
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
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "o/r",
        },
      },
    )
    return {
      status: run.status,
      stderr: run.stderr,
      comment: readFileSync(join(out, "comment.md"), "utf8"),
    }
  }
  const missing = decideWith("gate", {
    "critics.json": record("missing"),
  })
  assert.equal(missing.status, 1, missing.stderr)
  assert.ok(missing.comment.includes("#### Review critics"))
  assert.ok(
    missing.comment.includes(
      `[${sha(7).slice(0, 7)}](https://github.com/o/r/commit/${sha(7)})`,
    ),
  )
  assert.ok(missing.comment.includes("Fix: run `factory check` on the PR head"))
  // Shadow mode only reports it; a gate whose critics all have a verdict passes.
  assert.equal(
    decideWith("shadow", { "critics.json": record("missing") }).status,
    0,
  )
  assert.equal(
    decideWith("gate", { "critics.json": record("not-applicable") }).status,
    0,
  )
})

test("a same-repo PR whose critics were not checked fails the gate with the cause; a fork PR does not", () => {
  const directory = inputs({})
  writeFileSync(
    join(directory, "critics-cause.txt"),
    "factory review gate failed with exit code 2\n",
  )
  const checked = critics(directory)
  assert.deepEqual(checked.missing, [])
  assert.equal(checked.checked, false)
  assert.equal(criticsFail(checked), true)
  const text = criticsText(checked)
  assert.ok(
    text.includes(
      "Not checked: `factory review gate failed with exit code 2`.",
    ),
  )
  assert.ok(text.includes("the gate fails"))
  const skipped = critics(inputs({}), {
    needs: { "merge-gate-critics": { result: "skipped" } },
  })
  assert.equal(skipped.cause, "the critics job (skipped) uploaded no record")
  assert.equal(criticsFail(skipped), true)
  // The record downloads only by the id that the critics job gives: a job
  // without the id (a failed upload) has no record, whatever its result.
  const noId = critics(inputs({}), {
    needs: { "merge-gate-critics": { result: "success", outputs: {} } },
  })
  assert.equal(noId.cause, "the critics job (success) uploaded no record")
  assert.equal(criticsFail(noId), true)
  const lost = critics(inputs({}), {
    needs: {
      "merge-gate-critics": {
        result: "success",
        outputs: { "artifact-id": "123" },
      },
    },
  })
  assert.equal(lost.cause, "the critics record (artifact 123) did not download")
  assert.equal(criticsFail(lost), true)
  // An empty list or an unknown status never passes.
  const empty = critics(inputs({ "critics.json": { critics: [] } }))
  assert.equal(empty.cause, "the critics record lists no critics")
  assert.equal(criticsFail(empty), true)
  const unknown = critics(
    inputs({
      "critics.json": {
        critics: [{ critic: "critic:spec", status: "stale" }],
      },
    }),
  )
  assert.deepEqual(unknown.missing, ["critic:spec"])
  const fork = critics(inputs({}), { fork: true })
  assert.equal(criticsFail(fork), false)
  assert.ok(criticsText(fork).includes("a fork PR gets no role"))
})

test("the critics section says that the gate proves an attested review, not a sound one", () => {
  const directory = inputs({
    "critics.json": {
      head: sha(8),
      critics: [
        { critic: "critic:spec", status: "carried", reason: "1 passes" },
      ],
    },
  })
  const text = criticsText(critics(directory))
  assert.ok(text.includes("an agent recorded a review of these hunks"))
  assert.ok(text.includes("open CTO decision"))
})

test("each override of a visual verdict shows its reason, writer and commit; none is silent", () => {
  const reason =
    "The ticket asks for the shorter label | the model reads the new label as `cut` text, and this reason is longer than two hundred characters so that the table cut would hide its end if the comment used it."
  const directory = inputs({
    "critics.json": {
      head: sha(8),
      critics: [
        {
          critic: "critic:visual",
          status: "carried",
          reason:
            "0 passes and 1 units decided by a dispute (1 overridden by the implementer with a reason)",
          overrides: [
            {
              finding: "f:0123abcd",
              path: "ui/screenshots/Card.Main.desktop.screenshot.png",
              reason,
              commit: sha(9),
              writer: "a".repeat(64),
            },
            {
              finding: "f:4567cdef",
              path: "ui/screenshots/Card.Other.desktop.screenshot.png",
              reason: `${"x".repeat(280)} | a | b`,
              commit: "not a commit",
              writer: "someone@example.com",
            },
          ],
        },
      ],
    },
  })
  const text = criticsText(critics(directory), "https://github.com/o/r")
  assert.ok(text.includes("Overridden verdicts: 2"), text)
  assert.ok(text.includes("`f:0123abcd`"), text)
  assert.ok(
    text.includes("`ui/screenshots/Card.Main.desktop.screenshot.png`"),
    text,
  )
  assert.ok(text.includes(`by writer \`${"a".repeat(64)}\``), text)
  // A writer or a commit of another shape never reaches the comment.
  assert.ok(!text.includes("someone@example.com"), text)
  assert.ok(text.includes("by writer `unknown` at `unknown`"), text)
  // A reason at the limit, with pipes, shows in full. A list item is not a
  // table cell, so its pipes stay as they are.
  assert.ok(text.includes(`${"x".repeat(280)} | a | b\``), text)
  assert.ok(text.includes(`(https://github.com/o/r/commit/${sha(9)})`), text)
  // The full reason, with no backtick that ends the span.
  assert.ok(text.includes(reason.replace(/`/g, "'")), text)
  const plain = criticsText(
    critics(
      inputs({
        "critics.json": {
          head: sha(8),
          critics: [
            { critic: "critic:spec", status: "carried", reason: "1 passes" },
          ],
        },
      }),
    ),
  )
  assert.ok(!plain.includes("Overridden verdicts"), plain)
})

test("the comment reads the JSON of `factory review gate --json`: each override and each raised limit", () => {
  // The output of the factory binary, from the factory CLI test
  // `the_gate_json_of_the_binary_names_each_override_and_raised_limit`
  // (run it with `--nocapture`). A change of the factory shape fails here.
  const gate = JSON.parse(
    readFileSync(
      join(root, "scripts/tests/fixtures/factory/review-gate-overrides.json"),
      "utf8",
    ),
  )
  const visual = gate.critics.find(
    (critic) => critic.critic === "critic:visual",
  )
  const [override] = visual.overrides
  const [raise] = visual.limitRaises
  // The fixture has a long reason with a pipe and an emoji.
  assert.ok(override.reason.includes("|") && override.reason.includes("🙂"))
  const text = criticsText(
    critics(inputs({ "critics.json": gate })),
    "https://github.com/o/r",
  )
  assert.ok(text.includes("Overridden verdicts: 1"), text)
  assert.ok(text.includes(`by writer \`${override.writer}\``), text)
  assert.ok(
    text.includes(`(https://github.com/o/r/commit/${override.commit})`),
    text,
  )
  // The full reason: not cut, its pipe as it is, its emoji kept.
  assert.ok(text.includes(`: \`${override.reason}\``), text)
  // Each raised spend limit shows, with its writer and its commit.
  assert.ok(text.includes("Raised spend limits: 1"), text)
  assert.ok(
    text.includes(
      `- \`critic:visual\` limit $7.50, set by writer \`${raise.writer}\` at [${raise.commit.slice(0, 7)}](https://github.com/o/r/commit/${raise.commit})`,
    ),
    text,
  )
  // A table cell still escapes a pipe.
  const piped = criticsText(
    critics(
      inputs({
        "critics.json": {
          critics: [
            { critic: "critic:spec", status: "carried", reason: "a | b" },
          ],
        },
      }),
    ),
  )
  assert.ok(piped.includes("`a \\| b`"), piped)
})

test("the critics job projection keeps each override and raised limit for the comment", () => {
  // The same jq filter as the critics job in ci.yaml, on the output of the
  // factory binary.
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const [, filter] = workflow.match(/jq -c '(\{critics: [^']+)'/) ?? []
  assert.ok(filter, "the critics job has no jq projection")
  const fixture = join(
    root,
    "scripts/tests/fixtures/factory/review-gate-overrides.json",
  )
  const projected = spawnSync("jq", ["-c", filter, fixture], {
    encoding: "utf8",
  })
  assert.equal(projected.status, 0, projected.stderr)
  const record = JSON.parse(projected.stdout)
  // The projection drops what gate.mjs does not read.
  assert.ok(!projected.stdout.includes("disputes"), projected.stdout)
  const gate = JSON.parse(readFileSync(fixture, "utf8"))
  const visual = gate.critics.find(
    (critic) => critic.critic === "critic:visual",
  )
  const text = criticsText(
    critics(inputs({ "critics.json": record })),
    "https://github.com/o/r",
  )
  assert.ok(text.includes("Overridden verdicts: 1"), text)
  for (const override of visual.overrides)
    assert.ok(
      text.includes(
        `- \`critic:visual\` \`${override.finding}\` on \`${override.path}\`, by writer \`${override.writer}\` at [${override.commit.slice(0, 7)}](https://github.com/o/r/commit/${override.commit}): \`${override.reason}\``,
      ),
      text,
    )
  assert.ok(text.includes("Raised spend limits: 1"), text)
  for (const raise of visual.limitRaises)
    assert.ok(
      text.includes(
        `- \`critic:visual\` limit $${raise.limitUsd.toFixed(2)}, set by writer \`${raise.writer}\` at [${raise.commit.slice(0, 7)}](https://github.com/o/r/commit/${raise.commit})`,
      ),
      text,
    )
})

test("the comment includes the screenshots section that the factory makes for a command critic", () => {
  // The output of the factory binary, from the factory CLI test
  // `the_gate_json_of_a_command_critic_holds_the_section_of_its_changed_images`
  // (run it with `--nocapture`), through the jq filter of the critics job.
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const [, filter] = workflow.match(/jq -c '(\{critics: [^']+)'/) ?? []
  const fixture = join(
    root,
    "scripts/tests/fixtures/factory/review-gate-section.json",
  )
  const projected = spawnSync("jq", ["-c", filter, fixture], {
    encoding: "utf8",
  })
  assert.equal(projected.status, 0, projected.stderr)
  const record = JSON.parse(projected.stdout)
  const { section } = JSON.parse(readFileSync(fixture, "utf8")).critics.find(
    (critic) => critic.critic === "critic:visual",
  )
  assert.match(section, /^Changed screenshots: 2\./)
  // A model critic has no section, so the projection adds none.
  assert.equal(
    record.critics.find((critic) => critic.critic === "critic:spec").section,
    undefined,
  )
  const text = criticsText(critics(inputs({ "critics.json": record })))
  assert.ok(text.includes(`##### \`critic:visual\`\n\n${section}`), text)
  // A section that is not text never reaches the comment.
  const odd = criticsText(
    critics(
      inputs({
        "critics.json": {
          critics: [
            {
              critic: "critic:visual",
              status: "missing",
              reason: "r",
              section: { text: "x" },
            },
          ],
        },
      }),
    ),
  )
  assert.ok(!odd.includes("#####"), odd)
  // A long section with no line break is cut at the bound all the same.
  const long = criticsText(
    critics(
      inputs({
        "critics.json": {
          critics: [
            {
              critic: "critic:visual",
              status: "missing",
              reason: "r",
              section: "x".repeat(30000),
            },
          ],
        },
      }),
    ),
  )
  assert.ok(long.includes(`${"x".repeat(25000)}\n\nThe section is cut`), "cut")
  assert.ok(!long.includes("x".repeat(25001)), "bound")
})

test("a raised limit of another shape never reaches the comment", () => {
  const text = criticsText(
    critics(
      inputs({
        "critics.json": {
          critics: [
            {
              critic: "critic:visual",
              status: "carried",
              reason: "1 passes",
              limitRaises: [
                {
                  limitUsd: "lots",
                  writer: "someone@example.com",
                  commit: "not a commit",
                },
              ],
            },
          ],
        },
      }),
    ),
  )
  assert.ok(text.includes("Raised spend limits: 1"), text)
  assert.ok(!text.includes("someone@example.com"), text)
  assert.ok(!text.includes("lots"), text)
  assert.ok(
    text.includes("limit `unknown`, set by writer `unknown` at `unknown`"),
    text,
  )
})

test("a lint or policy check takes the result of its step in the Lint and format job", () => {
  const steps = (failed) => ({
    jobs: [
      {
        name: "Lint and format",
        started_at: "2026-10-27T10:00:00Z",
        completed_at: "2026-10-27T10:01:00Z",
        steps: [
          { name: "Run pnpm lint", conclusion: failed ? "failure" : "success" },
          { name: "CI command regression tests", conclusion: "skipped" },
        ],
      },
    ],
  })
  const decision = (failed) =>
    decide({
      needs: { "test-shards": "success", test: "success", lint: "failure" },
      shadow: {
        records: records.map((record) => ({ ...record, status: "passed" })),
        jobs: steps(failed),
      },
    })
  const oxlint = (d) =>
    d.ran.find(({ id }) => id === "lint:oxlint:.oxlintrc.json")
  // The agent hit of oxlint is accepted, so make it run: no agent results.
  const run = (failed) =>
    shadow({
      config: { ...pinned, acceptAgentResults: false },
      inputs: inputs({
        "mode.json": { mode: "select", reason: "shadow" },
        "selection.json": selection(),
      }),
      records: records.map((record) => ({ ...record, status: "passed" })),
      needs: needs({
        "test-shards": "success",
        test: "success",
        lint: "failure",
      }),
      jobs: steps(failed),
      run: {},
    })
  assert.equal(oxlint(run(true)).result, "failed")
  assert.equal(run(true).gatedRun.verdict, "fail")
  const { unverified: _, ...recall } = run(true).metrics.recall
  assert.deepEqual(recall, { failed: 1, ran: 1, escaped: [] })
  assert.equal(oxlint(run(false)).result, "passed")
  assert.equal(decision(false).gatedRun.verdict, "pass")
})

test("the step names of the Lint and format job are the steps in ci.yaml", async () => {
  const { lintSteps } = await import("../checks/shard.mjs")
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const lint = workflow.slice(
    workflow.indexOf("  lint:\n"),
    workflow.indexOf("\n  typecheck:\n"),
  )
  for (const name of [
    ...Object.keys(lintSteps),
    "CI command regression tests",
  ]) {
    const named = name.startsWith("Run ")
      ? lint.includes(`- run: ${name.slice(4)}\n`)
      : lint.includes(`- name: ${name}\n`)
    assert.ok(named, name)
  }
})

// The critics job redacts the stderr of factory review gate with sed before
// it reaches the log or the cause file. gate.mjs shows the cause as it is.
test("the critics cause and the log of factory review gate hold no URL or credential", () => {
  const ci = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const fn = /^ {10}redact\(\) \{\n[\s\S]*?^ {10}\}$/m.exec(ci)?.[0]
  assert.ok(fn, "the redact function of the critics job")
  const redact = (text) => {
    const run = spawnSync("bash", ["-c", `${fn}\nredact`], {
      input: `${text}\n`,
      encoding: "utf8",
    })
    assert.equal(run.status, 0, run.stderr)
    return run.stdout.replace(/\n$/, "")
  }
  const line =
    "error: GET https://bucket.s3.amazonaws.com/x?X-Amz-Signature=abc failed; Bearer abc.def AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG ghp_0123456789abcdefghijklmnopqrstuvwxyzAB AKIAIOSFODNN7EXAMPLE id 0123456789abcdef0123456789abcdef01"
  const clean = redact(line)
  for (const leak of [
    "https://",
    "amazonaws",
    "abc.def",
    "wJalrXUtnFEMI",
    "ghp_",
    "AKIAIOSFODNN7EXAMPLE",
    "0123456789abcdef0123456789abcdef01",
  ])
    assert.ok(!clean.includes(leak), `${leak}: ${clean}`)
  assert.ok(clean.startsWith("error: GET [REDACTED-URL] failed;"), clean)
  for (const plain of [
    "the store failed: AccessDenied",
    "plain text, a path src/a.ts:12",
  ])
    assert.equal(redact(plain), plain)
  const json = redact(
    '{"token":"abc123","password": "made up, pass", "secret":"a\\"b c"} Authorization: Basic dXNlcjpwYXNz',
  )
  for (const leak of ["abc123", "made", "up, pass", "b c", "dXNlcjpwYXNz"])
    assert.ok(!json.includes(leak), `${leak}: ${json}`)
  for (const sample of [
    "{'password': 'made up pass'} x",
    '{"password":"made up https://example.com/x"}',
    '{"password":"made up pass',
    "a\npassword: 'made up https://x\nnext line",
    '{"password":"made up \\"pass',
    '{"password":"made up\\',
    '{"token":"abc123","password": "made-up!pass", "key":1}',
    '{"password":"made up https://example.com/x","token": "Bearer a b"} y',
  ])
    assert.ok(!redact(sample).includes("made"), redact(sample))
  const tokens = redact(
    "token xyz and password=hunter2 sk-abc123 eyJhbGciOi.x.y",
  )
  for (const leak of ["xyz", "hunter2", "sk-abc123", "eyJhbGciOi"])
    assert.ok(!tokens.includes(leak), `${leak}: ${tokens}`)
})
