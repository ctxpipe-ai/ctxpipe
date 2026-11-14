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

import { parse as parseYaml } from "yaml"

import { fullVerdict, gateDecision, gateText, marker } from "../checks/gate.mjs"
import {
  jobPlans,
  nightlyPlan,
  plan,
  placeOf,
  readStore,
} from "../checks/plan.mjs"
import { runsInOf } from "../checks/shard.mjs"

// The gate mode of the merge gate (scripts/checks/README.md, Merge gate):
// the plan of a PR run, the gated verdict, the PR store and the CI jobs that
// run the plan.

const root = fileURLToPath(new URL("../../", import.meta.url))
const sha = (n) => String(n).repeat(40).slice(0, 40)
const key = (n) => String(n).repeat(64).slice(0, 64)
const config = (mode = "gate") => ({
  mode,
  factory: { version: sha(1), sha256: key(2) },
  acceptAgentResults: true,
  acceptPrResults: true,
})

const ui = "vitest:ui:apps/ui/src/a.test.tsx"
const backend = "vitest:backend:apps/backend/src/b.test.ts"
const contract = "vitest:contracts:apps/backend/src/c.contract.test.ts"
const story = "storybook:required:apps/ui/src/d.stories.tsx#d--one"
const lint = "lint:oxlint:.oxlintrc.json"
const image = "build:image-ui:apps/ui/Dockerfile"
const evalCase = "eval:mcp:apps/backend/evals/mcp/cases.ts#stale-cursor"
const deploy = "deploy:preview:.github/workflows/pr-deploy.yaml"
const omitted = "vitest:backend:apps/backend/src/e.test.ts"

const check = (id, reason = { kind: "changed" }) => ({
  id,
  lane: id.split(":")[1],
  reason,
})
const hit = (id, source, n) => ({
  id,
  key: key(n),
  source,
  provenance: {
    hostKind: source === "ci" ? "ci" : "laptop",
    createdAt: "2026-10-28T10:00:00Z",
  },
})

// The record of the select job: the deterministic selection and its cache
// lookup (`factory check --cache-only --json`).
const selectRecord = () => ({
  schemaVersion: 1,
  variant: "b",
  base: sha(6),
  trace: { commit: sha(7), checks: 787 },
  counts: { selected: 7, total: 9, stochasticOmitted: 0 },
  selected: [ui, backend, contract, story, lint, image, evalCase].map((id) =>
    check(id),
  ),
  omitted: [{ id: omitted, lane: "backend", reason: "not reached" }],
  notes: ["variant B"],
  cache: {
    shared: true,
    hits: [hit(story, "ci", 3), hit(lint, "agent", 4)],
    misses: [
      { id: ui, key: key(5), mode: "traced" },
      { id: backend, key: key(6), mode: "traced" },
      { id: contract, key: key(8), mode: "traced" },
    ],
    unkeyed: [],
    notes: [],
  },
})

// The record of the LLM job (`--llm-provider openrouter --dry-run`): it dropped the
// backend test and added the preview deployment.
const llmRecord = () => ({
  ...selectRecord(),
  selected: [ui, contract, story, lint, image, evalCase, deploy].map((id) =>
    check(id),
  ),
  omitted: [
    { id: omitted, lane: "backend", reason: "not reached" },
    { id: backend, lane: "backend", reason: "dropped by the LLM: same path" },
  ],
  cache: undefined,
  llm: {
    provider: "openrouter",
    fallback: null,
    cached: false,
    latencyMs: 12300,
    usage: { inputTokens: 9000, outputTokens: 800, costUsd: 0.006 },
    change: "renames a UI prop",
    kind: "refactor",
    behaviors: ["UI renders the prop"],
    kept: [{ id: ui, reason: "observes the prop" }],
    dropped: [{ id: backend, reason: "same path" }],
    added: [{ id: deploy, reason: "deploy config" }],
    floor: 0,
  },
})

function inputs(files) {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-merge-gate-plan-"))
  for (const [name, value] of Object.entries(files))
    writeFileSync(
      join(directory, name),
      typeof value === "string" ? value : JSON.stringify(value),
    )
  return directory
}

const needs = {
  "merge-gate-manifest": { result: "success" },
  "merge-gate-select": { result: "success" },
}
const store = (entries = [], quarantined = []) =>
  readStore({ schemaVersion: 1, entries, quarantined })

const planOf = (options = {}) =>
  plan({
    config: config(options.mode),
    inputs: inputs({
      "mode.json": { mode: "select", reason: "gate" },
      "selection.json": selectRecord(),
      "llm-selection.json": llmRecord(),
      ...options.files,
    }),
    needs,
    store: options.store ?? store(),
    fork: options.fork ?? false,
  })

test("the plan takes the LLM selection with the cache lookup of the select job", () => {
  const planned = planOf()
  assert.equal(planned.mode, "gate")
  assert.deepEqual(
    planned.selection.selected.map(({ id }) => id),
    [ui, contract, story, lint, image, evalCase, deploy],
  )
  // The hits of the select job stay; the dropped check has no lookup.
  assert.deepEqual(
    planned.hits.map(({ id, source }) => [id, source]),
    [
      [story, "ci"],
      [lint, "agent"],
    ],
  )
  assert.deepEqual(planned.ran, [ui, contract, image, evalCase, deploy])
  assert.equal(planned.selection.llm.change, "renames a UI prop")
  // The LLM added the deployment, so the merge gate starts PR Deploy.
  assert.equal(planned.deploy, true)
})

test("a failed LLM job, an invalid LLM record or a provider fallback keeps the deterministic selection", () => {
  for (const [files, cause] of [
    [
      {
        "llm-selection.json": "",
        "llm-cause.txt": "the selector did not finish in 170 seconds",
      },
      "the selector did not finish in 170 seconds",
    ],
    [
      { "llm-selection.json": { ...llmRecord(), selected: "all" } },
      "no valid selection record",
    ],
    [
      {
        "llm-selection.json": {
          ...llmRecord(),
          llm: { ...llmRecord().llm, fallback: "provider error 503" },
        },
      },
      "provider fallback (provider error 503)",
    ],
  ]) {
    const kept = planOf({ files })
    // The run stays gated, with the selection of the select job.
    assert.equal(kept.mode, "gate", cause)
    assert.ok(kept.ran.includes(backend), cause)
    assert.ok(!kept.ran.includes(deploy), cause)
    assert.ok(
      kept.selection.notes.includes(
        `llm job: ${cause}; the deterministic selection stays`,
      ),
      cause,
    )
  }
})

test("a UI-only change starts no Lint job when the passes of its keys are stored, and a full Lint job without the factory", () => {
  // Without the factory selector (a fork, a public clone, a failed select
  // job), no check has a key: the run is full, and each job runs all of its
  // checks.
  const full = plan({
    config: config(),
    inputs: inputs({
      "mode.json": { mode: "select", reason: "gate" },
      "select-cause.txt": "the factory selector is not installed",
    }),
    needs: { ...needs, "merge-gate-select": { result: "failure" } },
    store: store(),
    fork: false,
  })
  assert.deepEqual(
    [full.mode, full.reason, full.jobs],
    ["full", "selector unavailable: the factory selector is not installed", {}],
  )
  // With the factory selector on PATH, it computes the real keys of a
  // UI-only change to a copy of HEAD. The factory is private and optional:
  // the public checks stay correct without it.
  const probe = spawnSync("factory", ["check", "--help"], { encoding: "utf8" })
  if (probe.error || probe.status !== 0) return
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-ui-only-"))
  try {
    const run = (command, args, cwd = root) => {
      const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      })
      assert.equal(result.error, undefined, `${command}: ${result.error}`)
      return result
    }
    const manifest = join(directory, "manifest.json")
    const listed = run(process.execPath, ["scripts/checks/list.mjs"])
    assert.equal(listed.status, 0, listed.stderr)
    writeFileSync(manifest, listed.stdout)
    const toolchain = join(directory, "toolchain.json")
    const recorded = run("factory", [
      "toolchain",
      "--repo",
      root,
      "--manifest",
      manifest,
    ])
    assert.equal(recorded.status, 0, recorded.stderr)
    writeFileSync(toolchain, recorded.stdout)
    const clone = join(directory, "clone")
    const head = run("git", ["rev-parse", "HEAD"]).stdout.trim()
    run("git", ["clone", "-q", "--shared", "--no-checkout", root, clone])
    run("git", ["checkout", "-q", "--detach", head], clone)
    writeFileSync(
      join(clone, "apps/ui/src/components/onboarding/org-name.ts"),
      `${readFileSync(join(clone, "apps/ui/src/components/onboarding/org-name.ts"), "utf8")}export const uiOnlyProbe = 1\n`,
    )
    const selected = run("factory", [
      "check",
      "--repo",
      clone,
      "--base",
      "HEAD",
      "--cache-only",
      "--json",
      "--llm-provider",
      "none",
      "--manifest",
      manifest,
      "--toolchain",
      toolchain,
    ])
    const selection = JSON.parse(selected.stdout.split("\n")[0])
    const ids = selection.selected.map(({ id }) => id)
    // The repository scan of the check tests guards the change; the other
    // tests of the CI scripts and the ADR check do not read it.
    assert.ok(
      ids.includes(
        "policy:tests-ci-checks-repo:scripts/tests/ci-checks-repo.test.mjs",
      ),
    )
    for (const id of ids)
      assert.doesNotMatch(
        id,
        /^policy:(tests-ci-checks:|adr:|tests-[^:]+:scripts\/tests\/[^:]+\.test\.sh$)/,
      )
    // Each selected check of the Lint job has a key. With a stored pass of
    // each key (here the PR store of an earlier run), the Lint job does not
    // start.
    const lint = ids.filter((id) => placeOf(id).job === "lint")
    assert.ok(lint.length > 0)
    assert.deepEqual(
      selection.cache.unkeyed.filter(({ id }) => lint.includes(id)),
      [],
    )
    const planned = plan({
      config: config(),
      inputs: inputs({
        "mode.json": { mode: "select", reason: "gate" },
        "selection.json": selection,
      }),
      needs,
      store: store(
        selection.cache.misses.map(({ id, key }) => ({
          id,
          key,
          run: "1",
          createdAt: "2026-11-14T00:00:00Z",
        })),
      ),
      fork: false,
    })
    assert.equal(planned.mode, "gate")
    assert.equal(planned.outputs.lint, undefined)
    assert.equal(planned.jobs.lint, undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("each planned check goes to the job that runs it, and a job without one does not start", () => {
  const planned = planOf()
  assert.deepEqual(Object.keys(planned.outputs).sort(), [
    "package-tests",
    "production-builds",
    "test-shards",
  ])
  // The outputs only start the jobs: a count of checks, or the matrix
  // entries. Each job reads its check ids from plan.json.
  assert.equal(planned.outputs["package-tests"], "1")
  assert.deepEqual(JSON.parse(planned.outputs["test-shards"]), [
    { lane: "selected", shard: 1, count: 1 },
  ])
  assert.deepEqual(planned.jobs["package-tests"], { ids: [ui], rerun: [] })
  assert.deepEqual(planned.jobs["test-shards"], [
    {
      lane: "selected",
      shard: 1,
      count: 1,
      plan: { ids: [contract], rerun: [] },
    },
  ])
  // The report of the shards: the selected contract fits one of the nine
  // shards of a full run.
  assert.deepEqual(Object.keys(planned.shards), ["test-shards"])
  assert.equal(planned.shards["test-shards"].shards, 1)
  assert.equal(planned.shards["test-shards"].fullShards, 9)
  assert.deepEqual(JSON.parse(planned.outputs["production-builds"]), [
    { name: "ui", dockerfile: "apps/ui/Dockerfile" },
  ])
  // A lint or policy check runs in the Lint and format job. The stored pass
  // of the agent covers the only lint check, so that job does not start.
  // Evals, the Terraform plan and the deployment run in their own workflows.
  assert.deepEqual(placeOf(lint), { job: "lint" })
  assert.equal(planned.outputs.lint, undefined)
  // Without the stored pass, the lint job runs only that check.
  const missed = planOf({
    files: {
      "selection.json": {
        ...selectRecord(),
        cache: { ...selectRecord().cache, hits: [hit(story, "ci", 3)] },
      },
    },
  })
  assert.equal(missed.outputs.lint, "1")
  assert.deepEqual(missed.jobs.lint, { ids: [lint], rerun: [] })
  assert.match(placeOf(evalCase).workflow, /mcp-evals\.yaml/)
  // The Terraform plan runs in its own workflow, not in the Lint and format
  // job that runs the other policy checks.
  assert.match(
    placeOf("policy:terraform-plan:infra/main.tf").workflow,
    /terraform-plan-pr\.yaml/,
  )
  assert.match(placeOf(deploy).workflow, /pr-deploy\.yaml/)
  // Every Storybook play runs in the plays shards, after the build.
  const stories = planOf({
    files: {
      "llm-selection.json": {
        ...llmRecord(),
        selected: [
          check("storybook:required:apps/ui/src/e.stories.tsx#e--one"),
          check("storybook:plays:apps/ui/src/e.stories.tsx#e--two"),
        ],
      },
    },
  })
  assert.equal(stories.outputs["storybook-build"], "true")
  assert.equal(stories.jobs["storybook-plays"][0].plan.ids.length, 2)
  // A screenshot check runs in the screenshots shards, after the build.
  const screenshot = "storybook:visual:apps/ui/src/e.stories.tsx#e--one"
  assert.deepEqual(placeOf(screenshot), { job: "storybook-visual" })
  const shots = planOf({
    files: {
      "llm-selection.json": { ...llmRecord(), selected: [check(screenshot)] },
    },
  })
  assert.equal(shots.outputs["storybook-build"], "true")
  assert.deepEqual(JSON.parse(shots.outputs["storybook-visual"]), [
    { lane: "selected", shard: 1, count: 1 },
  ])
  assert.deepEqual(shots.jobs["storybook-visual"][0].plan.ids, [screenshot])
  assert.equal(shots.jobs["storybook-plays"], undefined)
})

test("shadow mode, a fork and a failed selector give a full run", () => {
  const shadow = planOf({ mode: "shadow" })
  assert.equal(shadow.mode, "full")
  assert.deepEqual(shadow.outputs, {})
  assert.deepEqual(shadow.jobs, {})
  assert.deepEqual(shadow.shards, {})
  assert.equal(shadow.deploy, false)
  // The shadow job still reads the combined selection.
  assert.ok(shadow.selection.llm)
  const failed = plan({
    config: config(),
    inputs: inputs({
      "mode.json": { mode: "select", reason: "gate" },
      "select-cause.txt":
        "the selector release does not match the pinned SHA-256",
    }),
    needs: { ...needs, "merge-gate-select": { result: "failure" } },
    store: store(),
    fork: false,
  })
  assert.equal(failed.mode, "full")
  assert.match(failed.reason, /does not match the pinned SHA-256/)
  // In gate mode a push does not start PR Deploy, so a full run starts it.
  assert.equal(failed.deploy, true)
  const fork = plan({
    config: config(),
    inputs: inputs({ "mode.json": { mode: "full", reason: "fork PR" } }),
    needs,
    store: store(),
    fork: true,
  })
  assert.deepEqual(
    [fork.mode, fork.reason, fork.deploy],
    ["full", "fork PR", false],
  )
})

test("a pass of an earlier run of the PR is a hit, and a quarantined key is not", () => {
  const passes = store([
    { id: ui, key: key(5), run: "41", createdAt: "2026-10-28T11:00:00Z" },
    // Another key: the inputs of the check changed since that run.
    { id: contract, key: key(9), run: "41", createdAt: "2026-10-28T11:00:00Z" },
  ])
  const planned = planOf({ store: passes })
  assert.deepEqual(
    planned.hits.find((item) => item.id === ui),
    {
      id: ui,
      key: key(5),
      source: "pr",
      provenance: {
        hostKind: "ci",
        createdAt: "2026-10-28T11:00:00Z",
        run: "41",
      },
    },
  )
  assert.ok(planned.ran.includes(contract))
  assert.ok(!planned.ran.includes(ui))
  // Without acceptPrResults the pass is not accepted, so the check runs again
  // with a rerun on failure.
  const refused = plan({
    config: { ...config(), acceptPrResults: false },
    inputs: inputs({
      "mode.json": { mode: "select", reason: "gate" },
      "selection.json": selectRecord(),
      "llm-selection.json": llmRecord(),
    }),
    needs,
    store: passes,
    fork: false,
  })
  assert.ok(refused.ran.includes(ui))
  assert.deepEqual(refused.rerun, [ui])
  // A key that this PR quarantined has no hit of any class.
  const blocked = planOf({ store: store([], [key(3)]) })
  assert.ok(blocked.ran.includes(story))
  assert.deepEqual(blocked.rerun, [story])
  assert.ok(
    blocked.selection.cache.notes.some((note) =>
      note.includes("ci hit is not accepted"),
    ),
  )
  // A store entry that does not parse is left out.
  assert.deepEqual(
    readStore({
      schemaVersion: 1,
      entries: [{ id: ui, key: "x", run: "1" }],
      quarantined: ["y"],
    }),
    { schemaVersion: 1, entries: [], quarantined: [] },
  )
})

const jobs = (results) => ({
  jobs: [
    {
      name: "Merge gate manifest",
      started_at: "2026-10-28T10:00:00Z",
      completed_at: "2026-10-28T10:01:00Z",
      conclusion: "success",
      steps: [],
    },
    {
      name: "UI, CLI and CDK tests",
      started_at: "2026-10-28T10:04:00Z",
      completed_at: "2026-10-28T10:07:00Z",
      conclusion: results.packages ?? "success",
      steps: [],
    },
    {
      name: "Production build (ui)",
      started_at: "2026-10-28T10:04:00Z",
      completed_at: "2026-10-28T10:06:00Z",
      conclusion: results.image ?? "success",
      steps: [],
    },
    {
      name: "Merge gate",
      started_at: "2026-10-28T10:10:00Z",
      completed_at: null,
      steps: [],
    },
  ],
})

const decide = (options = {}) => {
  const planned = planOf({ store: options.store, files: options.files })
  return gateDecision({
    config: config(),
    planned,
    records: options.records ?? [
      { id: ui, status: "passed" },
      { id: contract, status: "passed" },
    ],
    reruns: options.reruns ?? [],
    needs: {
      ...needs,
      lint: { result: options.lint ?? "success" },
      "terraform-validate": { result: "success" },
      migrate: { result: options.migrate ?? "success" },
    },
    jobs: jobs(options.jobs ?? {}),
    run: { id: "42", attempt: 1, pr: 7, sha: sha(9) },
    store: options.store ?? store(),
    now: new Date("2026-10-28T12:00:00Z"),
  })
}

test("the gated verdict needs a result for each planned check of CI", () => {
  const { decision, store: next } = decide()
  assert.equal(decision.gatedRun.verdict, "pass")
  assert.deepEqual(
    decision.ran.map(({ id, result }) => [id, result]),
    [
      [ui, "passed"],
      [contract, "passed"],
      [image, "passed"],
    ],
  )
  // The other workflows report their own status.
  assert.deepEqual(
    decision.external.map(({ id }) => id),
    [evalCase, deploy],
  )
  // Each check that passed under a key goes to the PR store.
  assert.deepEqual(
    next.entries.map(({ id, key: k, run }) => [id, k, run]),
    [
      [ui, key(5), "42"],
      [contract, key(8), "42"],
    ],
  )
  assert.equal(decision.cost.gatedRunMinutes, 6)
  const failed = decide({ jobs: { image: "failure" } })
  assert.equal(failed.decision.gatedRun.verdict, "fail")
  assert.deepEqual(failed.decision.gatedRun.failedChecks, [image])
  const missing = decide({ records: [{ id: ui, status: "passed" }] })
  assert.deepEqual(missing.decision.gatedRun.failedChecks, [contract])
  assert.equal(decide({ migrate: "failure" }).decision.gatedRun.verdict, "fail")
})

test("a lint or policy check needs its record from the Lint and format job, which is not an always-run job", () => {
  // The lint check has no stored pass, so the lint job runs it.
  const files = {
    "selection.json": {
      ...selectRecord(),
      cache: { ...selectRecord().cache, hits: [hit(story, "ci", 3)] },
    },
  }
  const others = [
    { id: ui, status: "passed" },
    { id: contract, status: "passed" },
  ]
  const run = (records, lint = "success") =>
    decide({ files, records, lint }).decision.gatedRun
  assert.equal(run([...others, { id: lint, status: "passed" }]).verdict, "pass")
  assert.deepEqual(
    run([...others, { id: lint, status: "failed" }], "failure").failedChecks,
    [lint],
  )
  // A lint job that failed before it wrote a record gives a missing result:
  // the check fails, and the job is not an always-run job.
  const lost = run(others, "failure")
  assert.deepEqual(lost.failedChecks, [lint])
  assert.deepEqual(lost.failedAlwaysRun, [])
})

test("a failed check with a stored pass runs again, and a second failure quarantines the key", () => {
  // The PR store has a pass for the contract key, but the pr class is not
  // accepted, so the check ran.
  const passes = store([
    { id: contract, key: key(8), run: "41", createdAt: "2026-10-28T11:00:00Z" },
  ])
  const run = (rerun) =>
    gateDecision({
      config: { ...config(), acceptPrResults: false },
      planned: plan({
        config: { ...config(), acceptPrResults: false },
        inputs: inputs({
          "mode.json": { mode: "select", reason: "gate" },
          "selection.json": selectRecord(),
          "llm-selection.json": llmRecord(),
        }),
        needs,
        store: passes,
        fork: false,
      }),
      records: [
        { id: ui, status: "passed" },
        { id: contract, status: "failed" },
      ],
      reruns: [{ id: contract, status: rerun }],
      needs: { ...needs, lint: { result: "success" } },
      jobs: jobs({}),
      run: { id: "42" },
      store: passes,
      now: new Date("2026-10-28T12:00:00Z"),
    })
  const confirmed = run("failed")
  assert.deepEqual(confirmed.decision.contradictions, [
    { id: contract, rerun: "failed", confirmed: true },
  ])
  assert.deepEqual(confirmed.store.quarantined, [key(8)])
  assert.ok(!confirmed.store.entries.some((entry) => entry.key === key(8)))
  assert.equal(confirmed.decision.gatedRun.verdict, "fail")
  // A pass on the rerun is a flake: nothing is quarantined, and the first
  // failure still fails the gated run.
  const flake = run("passed")
  assert.deepEqual(flake.store.quarantined, [])
  assert.equal(flake.decision.gatedRun.verdict, "fail")
})

test("the PR comment shows the selection, the hits, the LLM decisions and the minutes", () => {
  const { decision } = decide()
  const text = gateText(decision, "https://example.test/run", {
    limit: 40,
    comment: true,
  })
  assert.ok(text.startsWith(marker))
  for (const part of [
    "**Verdict:** pass",
    "3 ran, 2 hits (ci 1, agent 1), 2 in other workflows",
    "**Cache hits:** ci 1, pr 0, agent 1 of ",
    "renames a UI prop",
    "dropped 1, added 1",
    "<summary>LLM decisions (2)</summary>",
    "`same path`",
    "<summary>Omitted (2)</summary>",
    "a full run about",
    "**Shards:** `test-shards` 1 of 9 (about",
  ])
    assert.ok(text.includes(part), part)
})

test("the verdict line names each failed check and always-run job in full", () => {
  const { decision } = decide()
  const failed = {
    ...decision,
    gatedRun: {
      ...decision.gatedRun,
      verdict: "fail",
      failedChecks: ["lint:oxlint:.oxlintrc.json", "test:vitest:apps/ui"],
      failedAlwaysRun: ["migrate", "terraform-validate"],
    },
  }
  const text = gateText(failed, "https://example.test/run")
  assert.ok(
    text.includes(
      "**Verdict:** fail (failed checks: `lint:oxlint:.oxlintrc.json`, `test:vitest:apps/ui`) (failed always-run jobs: `migrate`, `terraform-validate`).",
    ),
    text,
  )
})

test("the CLI plans a gated run and fails the merge gate on a failed verdict", () => {
  const directory = inputs({
    "mode.json": { mode: "select", reason: "gate" },
    "selection.json": selectRecord(),
    "llm-selection.json": llmRecord(),
    "config.json": config(),
    "needs.json": needs,
  })
  const gate = (args) =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/checks/gate.mjs"), ...args],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, GITHUB_RUN_ID: "42" },
      },
    )
  const output = join(directory, "github-output")
  const planned = gate([
    "plan",
    "--config",
    join(directory, "config.json"),
    "--inputs",
    directory,
    "--needs",
    join(directory, "needs.json"),
    "--store",
    join(directory, "no-store.json"),
    "--fork",
    "false",
    "--out",
    directory,
    "--github-output",
    output,
  ])
  assert.equal(planned.status, 0, planned.stderr)
  const lines = readFileSync(output, "utf8").split("\n").filter(Boolean)
  assert.ok(lines.includes("mode=gate"))
  assert.ok(lines.includes("deploy=true"))
  assert.ok(lines.includes("package-tests=1"))
  const results = join(directory, "results", "test-results-selected-1")
  mkdirSync(results, { recursive: true })
  writeFileSync(
    join(results, "records.ndjson"),
    `${JSON.stringify({ id: ui, status: "failed" })}\n`,
  )
  writeFileSync(
    join(directory, "needs.json"),
    JSON.stringify({ ...needs, lint: { result: "success" } }),
  )
  const out = join(directory, "out")
  const decided = gate([
    "decide",
    "--config",
    join(directory, "config.json"),
    "--inputs",
    directory,
    "--results",
    join(directory, "results"),
    "--needs",
    join(directory, "needs.json"),
    "--store",
    join(directory, "no-store.json"),
    "--out",
    out,
  ])
  assert.equal(decided.status, 1, decided.stderr)
  assert.match(decided.stdout, /config gate; mode gate; verdict fail/)
  for (const file of [
    "decision.json",
    "summary.md",
    "comment.md",
    "store.json",
  ])
    assert.ok(existsSync(join(out, file)), file)
})

test("a check that fails in a full run loses its stored pass: gated, full, gated", () => {
  const directory = inputs({ "config.json": config() })
  const gate = (args) =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/checks/gate.mjs"), ...args],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, GITHUB_RUN_ID: "42" },
      },
    )
  // One run of the PR: plan, then decide with the given records. Each run
  // reads the PR store of the run before it.
  const runOnce = (name, files, runNeeds, status) => {
    const at = join(directory, name)
    mkdirSync(join(at, "results", "test-results-selected-1"), {
      recursive: true,
    })
    for (const [file, value] of Object.entries(files))
      writeFileSync(join(at, file), JSON.stringify(value))
    writeFileSync(join(at, "needs.json"), JSON.stringify(runNeeds))
    const store = join(directory, "store.json")
    const planned = gate([
      "plan",
      "--config",
      join(directory, "config.json"),
      "--inputs",
      at,
      "--needs",
      join(at, "needs.json"),
      "--store",
      store,
      "--fork",
      "false",
      "--out",
      at,
    ])
    assert.equal(planned.status, 0, planned.stderr)
    writeFileSync(
      join(at, "results", "test-results-selected-1", "records.ndjson"),
      `${JSON.stringify({ id: ui, status })}\n`,
    )
    gate([
      "decide",
      "--config",
      join(directory, "config.json"),
      "--inputs",
      at,
      "--results",
      join(at, "results"),
      "--needs",
      join(at, "needs.json"),
      "--store",
      store,
      "--out",
      join(at, "out"),
    ])
    writeFileSync(store, readFileSync(join(at, "out", "store.json")))
    return JSON.parse(readFileSync(join(at, "plan.json"), "utf8"))
  }
  const selected = {
    "mode.json": { mode: "select", reason: "gate" },
    "selection.json": selectRecord(),
    "llm-selection.json": llmRecord(),
  }
  const prHit = (planned) =>
    planned.selection?.cache?.hits.some(
      (item) => item.id === ui && item.source === "pr",
    )
  // Run 1 (gated): the UI test passes under its key and goes to the store.
  assert.equal(runOnce("1", selected, needs, "passed").mode, "gate")
  // Run 2 (full: the selector failed): the UI test fails.
  const full = runOnce(
    "2",
    { "mode.json": { mode: "select", reason: "gate" } },
    { ...needs, "merge-gate-select": { result: "failure" } },
    "failed",
  )
  assert.equal(full.mode, "full")
  // Run 3 (gated): the pass of run 1 is gone, so the UI test runs again.
  const third = runOnce("3", selected, needs, "passed")
  assert.equal(third.mode, "gate")
  assert.ok(!prHit(third))
  assert.ok(third.ran.includes(ui))
})

test("each job of the plan needs the plan job, starts only with its output, and runs the plan", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8")
  const job = (name) => {
    const start = workflow.indexOf(`\n  ${name}:\n`)
    assert.ok(start > 0, name)
    return workflow.slice(start, workflow.indexOf("\n\n  ", start + 1))
  }
  const plan = job("merge-gate-plan")
  const outputs = [
    "lint",
    "typecheck",
    "test-shards",
    "package-tests",
    "production-builds",
    "packages",
    "storybook-build",
    "storybook-plays",
    "storybook-visual",
    "codesearch",
    "vercel-sandbox",
    "upgrade-from-previous-release",
  ]
  for (const name of outputs) {
    assert.ok(
      plan.includes(`      ${name}: \${{ steps.plan.outputs.${name} }}`),
      `plan output ${name}`,
    )
    const text = job(name)
    assert.match(
      text,
      /\n {4}needs: (?:merge-gate-plan|\[merge-gate-plan, [\w-]+\])\n/,
      name,
    )
    assert.ok(
      text.includes("!cancelled() &&"),
      `${name} runs when the plan job skips`,
    )
    assert.ok(
      text.includes(
        `(needs.merge-gate-plan.outputs.mode != 'gate' || needs.merge-gate-plan.outputs.${name} != '')`,
      ),
      `${name} starts in gate mode only with its output`,
    )
  }
  // The jobs that run a subset run it through selected.mjs with their plan,
  // from plan.json of the plan job (the gate test checks the download by
  // artifact id). A matrix job gives its shard.
  for (const name of [
    "lint",
    "typecheck",
    "test-shards",
    "package-tests",
    "packages",
    "storybook-plays",
    "storybook-visual",
    "vercel-sandbox",
  ]) {
    const text = job(name)
    assert.ok(
      text.includes(
        "artifact-ids: ${{ needs.merge-gate-plan.outputs.artifact-id }}",
      ),
      `${name} downloads the plan`,
    )
    assert.match(
      text,
      new RegExp(
        `\n\\s+run: node scripts/checks/selected\\.mjs \\S+ "\\$RUNNER_TEMP/plan/plan\\.json" ${name}${text.includes("matrix:") ? ' "\\$SHARD"' : ""}\n`,
      ),
      name,
    )
    // No check id goes into the environment of a step.
    assert.doesNotMatch(text, /\bPLAN:|matrix\.plan/, name)
  }
  // A gated run has no full inventory and no required job.
  for (const name of ["test", "storybook-required"])
    assert.ok(
      job(name).includes("needs.merge-gate-plan.outputs.mode != 'gate'"),
      name,
    )
  // The merge gate job is the required status: a fixed name, it runs after
  // a failed plan job, and only gate.mjs decides whether it fails.
  const gate = job("merge-gate")
  assert.match(gate, /\n {4}name: Merge gate\n/)
  assert.doesNotMatch(gate, /\n {4}continue-on-error:/)
  assert.match(gate, /\n {4}if: \|\n {6}always\(\) && /)
  // The Terraform plan workflow has no pull_request trigger: the merge gate
  // calls it as a reusable workflow, so the PR author stays the actor. It
  // does so for a same-repository PR that changes a file under infra/,
  // whatever the mode or the selection. The critics job looks for the
  // change: it starts with the run and runs no repository code, so the step
  // gets the token that reads the PR files in a job of the same trust.
  const changes = job("merge-gate-critics")
  assert.doesNotMatch(changes, /\n {4}needs:/)
  assert.doesNotMatch(changes, /merge-gate-plan/)
  assert.ok(changes.includes("head.repo.full_name == github.repository"))
  assert.match(
    changes,
    /\n {6}- name: Look for a change under infra\/\n {8}id: changes\n {8}if: \|\n {10}!cancelled\(\) && github\.event\.action != 'ready_for_review'\n/,
  )
  assert.match(changes, /\n {6}plan: \$\{\{ steps\.changes\.outputs\.plan \}\}\n/)
  assert.match(changes, /\n {6}pull-requests: read\n/)
  // No repository code: no package manager, no runtime, no local action,
  // and no repository script.
  assert.doesNotMatch(
    changes
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n"),
    /\b(pnpm|npm|npx|node|bun|tsx)\b|uses: \.\/|\b(bash|sh) [\w./-]*scripts\//,
  )
  assert.ok(!workflow.includes("\n  merge-gate-terraform-changes:\n"))
  const terraform = job("merge-gate-terraform-plan")
  assert.match(terraform, /\n {4}needs: merge-gate-critics\n/)
  // A failed lookup of the critics fails their job, but not the plan start.
  assert.ok(
    terraform.includes(
      "!cancelled() && needs.merge-gate-critics.outputs.plan == 'true'",
    ),
  )
  assert.match(
    terraform,
    /\n {4}uses: \.\/\.github\/workflows\/terraform-plan-pr\.yaml\n/,
  )
  assert.doesNotMatch(terraform, /merge-gate-plan/)
  const terraformWorkflow = readFileSync(
    join(root, ".github/workflows/terraform-plan-pr.yaml"),
    "utf8",
  )
  assert.doesNotMatch(terraformWorkflow, /^ {2}pull_request:/m)
  assert.match(terraformWorkflow, /^ {2}workflow_call:/m)
  // The plan job takes the code by artifact id: a reusable workflow shares the
  // artifact names of the run, and other jobs of the run execute PR code.
  assert.match(
    terraformWorkflow,
    /artifact-ids: \$\{\{ needs\.resolve\.outputs\.artifact_id \}\}/,
  )
  assert.match(terraformWorkflow, /artifact_id != ''/)
  assert.doesNotMatch(
    terraformWorkflow,
    /download-artifact[^\n]*\n\s+with:\n\s+name:/,
  )
  assert.match(terraformWorkflow, /^ {2}workflow_dispatch:/m)
  // A failed plan job gives no mode: the run is full, so PR Deploy starts.
  assert.ok(
    job("merge-gate-deploy").includes(
      "needs.merge-gate-plan.outputs.mode == ''",
    ),
  )
})

test("a gated step has the setup of its full-run step and of the prerequisites of its checks", () => {
  // In gate mode, scripts/checks/run.mjs makes or verifies the prerequisites
  // of each check (prerequisites.mjs). The full-run step can use another
  // command that does not verify them, so a gated step can lack setup that
  // no full run shows.
  const { jobs } = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
  )
  const listed = spawnSync(
    process.execPath,
    [join(root, "scripts/checks/list.mjs")],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  )
  assert.equal(listed.status, 0, listed.stderr)
  const runsChecks = (step) =>
    /scripts\/checks\/(?:selected|run)\.mjs/.test(step.run ?? "")
  const gated = (step) =>
    /mode == 'gate'|matrix\.lane == 'selected'/.test(step.if ?? "")
  // A step of the full run only, or any step of a job of the full run only.
  const fullRun = (job, step) =>
    /mode != 'gate'|matrix\.lane != 'selected'/.test(step.if ?? "") ||
    /mode != 'gate'$/.test((job.if ?? "").trim())
  const envNames = (job, step) =>
    new Set([...Object.keys(job.env ?? {}), ...Object.keys(step.env ?? {})])
  // The names that only select the full set or switch on the trace, and the
  // names that only give a gated step its plan.
  const fullOnly = new Set(["EVENT", "STORYBOOK_PLAYS", "STORYBOOK_SHARD"])
  // The setup that a prerequisite needs from the job and the step.
  const setup = {
    postgres: (job, env) =>
      Boolean(job.services?.postgres) && env.has("DATABASE_URL"),
    migrations: (job) =>
      job.steps.some((step) => (step.run ?? "").includes("src/db/migrate.ts")),
    falkordb: (job, env) =>
      job.steps.some((step) => step.uses === "./.github/actions/falkordb") &&
      env.has("GRAPH_DB_URI"),
  }
  const pairs = new Map()
  for (const check of JSON.parse(listed.stdout).checks) {
    const gateJob = placeOf(check.id).job
    if (!jobs[gateJob]) continue
    const fullJob = runsInOf(check.id)?.job
    const pair = pairs.get(`${fullJob} ${gateJob}`) ?? {
      fullJob,
      gateJob,
      prerequisites: new Set(),
    }
    for (const name of check.prerequisites ?? []) pair.prerequisites.add(name)
    pairs.set(`${fullJob} ${gateJob}`, pair)
  }
  let compared = 0
  for (const { fullJob, gateJob, prerequisites } of pairs.values()) {
    const job = jobs[gateJob]
    for (const step of job.steps.filter(runsChecks)) {
      const env = envNames(job, step)
      for (const name of prerequisites)
        if (setup[name])
          assert.ok(
            setup[name](job, env),
            `${gateJob} / ${step.name}: no setup for the prerequisite ${name}`,
          )
      if (!gated(step) || !jobs[fullJob]) continue
      const full = jobs[fullJob]
      for (const service of Object.keys(full.services ?? {}))
        assert.ok(
          job.services?.[service],
          `${gateJob} has no service ${service} of ${fullJob}`,
        )
      for (const fullStep of full.steps.filter(
        (s) => s.run && fullRun(full, s),
      ))
        for (const name of envNames(full, fullStep))
          if (!fullOnly.has(name))
            assert.ok(
              env.has(name),
              `${gateJob} / ${step.name} has no ${name} of ${fullJob} / ${fullStep.name ?? fullStep.run}`,
            )
      compared++
    }
  }
  // typecheck, test-shards, package-tests, packages, storybook-plays (for its
  // own stories and the required ones), vercel-sandbox.
  assert.ok(compared >= 6, `${compared} gated steps compared`)
})

test("a failed plan job gives a full run, and the merge gate reports its verdict", () => {
  // The plan job failed before it wrote plan.json or any output: each check
  // job runs in full, and the merge gate fails with the full run.
  const decide = (
    result,
    critics = { critics: [{ critic: "critic:spec", status: "carried" }] },
  ) => {
    const directory = inputs({
      "mode.json": { mode: "select", reason: "gate" },
      "selection.json": selectRecord(),
      "llm-selection.json": llmRecord(),
      ...(critics ? { "critics.json": critics } : {}),
      "config.json": config(),
      "needs.json": {
        ...needs,
        "merge-gate-plan": { result: "failure", outputs: {} },
        lint: { result: "success" },
        "test-shards": { result },
      },
    })
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
        join(directory, "out"),
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, GITHUB_RUN_ID: "42" },
      },
    )
    const decision = JSON.parse(
      readFileSync(join(directory, "out", "decision.json"), "utf8"),
    )
    return { status: run.status, decision }
  }
  const failed = decide("failure")
  assert.equal(failed.status, 1)
  assert.notEqual(failed.decision.mode, "gate")
  assert.equal(failed.decision.fullRun.verdict, "fail")
  const passed = decide("success")
  assert.equal(passed.status, 0)
  assert.equal(passed.decision.fullRun.verdict, "pass")
  // A full run checks the critics too: a same-repo PR without the critics
  // record fails, with the cause.
  const unchecked = decide("success", null)
  assert.equal(unchecked.status, 1)
  assert.equal(unchecked.decision.critics.checked, false)
  assert.equal(unchecked.decision.critics.cause, "the critics job did not run")
})

test("the selected checks of a job run through the public runner, with records", () => {
  const directory = inputs({
    "plan.json": {
      jobs: {
        "package-tests": { ids: ["vitest:ui:no/such.test.ts"], rerun: [] },
        "test-shards": [
          {
            lane: "selected",
            shard: 1,
            count: 2,
            plan: { ids: ["vitest:backend:no/one.test.ts"], rerun: [] },
          },
          {
            lane: "selected",
            shard: 2,
            count: 2,
            plan: { ids: ["vitest:backend:no/two.test.ts"], rerun: [] },
          },
        ],
      },
    },
  })
  const selected = (results, ...args) =>
    spawnSync(
      process.execPath,
      [
        join(root, "scripts/checks/selected.mjs"),
        results,
        join(directory, "plan.json"),
        ...args,
      ],
      { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } },
    )
  const records = (results) =>
    readFileSync(join(results, "records.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  const run = selected(join(directory, "packages"), "package-tests")
  assert.equal(run.status, 1)
  const [record] = records(join(directory, "packages"))
  assert.deepEqual(
    [record.id, record.status, record.origin],
    ["vitest:ui:no/such.test.ts", "error", "runner"],
  )
  assert.match(
    run.stdout,
    /::group::error: vitest:ui:no\/such\.test\.ts \(Unknown check id\)/,
  )
  // A matrix entry runs only the checks of its shard.
  selected(join(directory, "shard"), "test-shards", "2")
  assert.deepEqual(
    records(join(directory, "shard")).map(({ id }) => id),
    ["vitest:backend:no/two.test.ts"],
  )
  for (const args of [["typecheck"], ["test-shards", "3"], ["test-shards"]]) {
    const empty = selected(join(directory, "empty"), ...args)
    assert.equal(empty.status, 1, args.join(" "))
    assert.match(empty.stderr, /the plan has no check ids for/, args.join(" "))
  }
})

test("a PR that selects every check gives the Merge gate job a needs value under the Linux limit", () => {
  // The Decision step of the Merge gate job gets `toJSON(needs)` in one
  // environment value. Linux limits one such value to 128 KiB
  // (MAX_ARG_STRLEN), so a larger value stops the step before gate.mjs
  // starts ("Argument list too long"). The outputs of the plan job are part
  // of that value, so they must not grow with the count of selected checks.
  const many = (count, make) => Array.from({ length: count }, (_, n) => make(n))
  const ids = [
    ...many(
      2500,
      (n) =>
        `vitest:backend:apps/backend/src/domain/area-${n % 40}/module-${n}.integration.test.ts`,
    ),
    ...many(
      800,
      (n) =>
        `storybook:plays:apps/ui/src/components/area-${n % 30}/component-${n}.stories.tsx#component-${n}--default`,
    ),
    ...many(
      300,
      (n) =>
        `vitest:ui:apps/ui/src/components/area-${n % 30}/component-${n}.test.tsx`,
    ),
  ]
  const directory = inputs({
    "mode.json": { mode: "select", reason: "gate" },
    "selection.json": {
      ...selectRecord(),
      counts: { selected: ids.length, total: ids.length, stochasticOmitted: 0 },
      selected: ids.map((id) => check(id)),
      omitted: [],
      cache: { ...selectRecord().cache, hits: [], misses: [] },
    },
    "llm-cause.txt": "the selector did not finish in 170 seconds",
    "config.json": config(),
    "needs.json": needs,
  })
  const output = join(directory, "github-output.txt")
  const run = spawnSync(
    process.execPath,
    [
      join(root, "scripts/checks/gate.mjs"),
      "plan",
      "--config",
      join(directory, "config.json"),
      "--inputs",
      directory,
      "--needs",
      join(directory, "needs.json"),
      "--store",
      join(directory, "store.json"),
      "--fork",
      "false",
      "--out",
      join(directory, "plan"),
      "--github-output",
      output,
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  )
  assert.equal(run.status, 0, run.stderr)
  const planned = JSON.parse(
    readFileSync(join(directory, "plan", "plan.json"), "utf8"),
  )
  assert.equal(planned.mode, "gate")
  assert.equal(planned.ran.length, ids.length)
  // The `needs` context of the Merge gate job as GitHub gives it: each job
  // that it needs, with each output that the job declares ("" when unset).
  const { jobs } = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
  )
  const planOutputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  )
  const gateNeeds = Object.fromEntries(
    jobs["merge-gate"].needs.map((name) => [
      name,
      {
        result: "success",
        outputs: Object.fromEntries(
          Object.keys(jobs[name].outputs ?? {}).map((key) => [
            key,
            key === "artifact-id"
              ? "13562464110"
              : name === "merge-gate-plan"
                ? (planOutputs[key] ?? "")
                : "",
          ]),
        ),
      },
    ]),
  )
  const bytes = Buffer.byteLength(`NEEDS=${JSON.stringify(gateNeeds, null, 2)}`)
  assert.ok(
    bytes < 128 * 1024,
    `toJSON(needs) of the Merge gate job is ${bytes} bytes`,
  )
})

test("the gate reads each record of a trusted job only by the artifact id that the job gives", () => {
  // A job that runs PR code holds the artifact token, so it can upload an
  // artifact with the name of a trusted record. The readers download a
  // trusted record only by the id from the upload step of its writer.
  const { jobs } = parseYaml(
    readFileSync(join(root, ".github/workflows/ci.yaml"), "utf8"),
  )
  const writers = {
    "merge-gate-select": "merge-gate-selection",
    "merge-gate-llm": "merge-gate-llm",
    "merge-gate-plan": "merge-gate-plan",
    "merge-gate-critics": "merge-gate-critics",
    "nightly-plan": "nightly-plan",
  }
  for (const [writer, name] of Object.entries(writers)) {
    const upload = jobs[writer].steps.find((step) => step.with?.name === name)
    assert.equal(upload.id, "preserve", writer)
    assert.match(
      jobs[writer].outputs["artifact-id"],
      /^\$\{\{ steps\.preserve\.outputs\.artifact-id \}\}$/,
      writer,
    )
  }
  for (const [reader, job] of Object.entries(jobs))
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith("actions/download-artifact@")) continue
      assert.ok(
        !Object.values(writers).includes(step.with?.name) &&
          !/^merge-gate-\*/.test(step.with?.pattern ?? ""),
        `${reader} downloads a trusted record by its name`,
      )
      const id = /^\$\{\{ needs\.([\w-]+)\.outputs\.artifact-id \}\}$/.exec(
        step.with?.["artifact-ids"] ?? "",
      )
      if (!id) continue
      assert.ok(id[1] in writers, `${reader}: ${id[1]}`)
      assert.ok([job.needs].flat().includes(id[1]), `${reader} needs ${id[1]}`)
      assert.equal(step.with["merge-multiple"], true, reader)
      // An empty id downloads every artifact of the run, so each reader needs
      // the guard. A check job also downloads the plan only in gate mode.
      assert.ok(
        String(step.if)
          .split(" && ")
          .includes(`needs.${id[1]}.outputs.artifact-id != ''`) &&
          !String(step.if).includes("||"),
        `${reader} downloads ${id[1]} without the empty-id guard`,
      )
    }
  // A failed upload of the critics shows as a failed job, and the critics
  // never fail the full verdict: gate.mjs decides them (criticsFail).
  assert.equal(jobs["merge-gate-critics"]["continue-on-error"], undefined)
  assert.equal(
    fullVerdict({
      "merge-gate-critics": { result: "failure" },
      lint: { result: "success" },
    }).verdict,
    "pass",
  )
})

// A record of `factory nightly plan` (CTX-1246): the checks to trace again,
// the audit sample, and `run`, the union of both.
const nightly = ({ full = null, trace = [], sample = [] } = {}) => ({
  schemaVersion: 1,
  commit: sha(3),
  createdAt: "2026-11-10T02:30:00Z",
  id: "a".repeat(32),
  previous: null,
  full,
  trace: trace.map((id) => ({ id, reason: "src/a.ts changed" })),
  kept: [],
  leftOut: [],
  audit: full ? null : { seed: key(4), population: sample.length, sample },
  run: [...new Set([...trace, ...sample])].sort(),
  estimate: { runMs: 0, allMs: 0 },
})

test("a nightly plan puts its checks into the jobs of the run, and a full one gives a full run", () => {
  const typecheck = "typecheck:ui:apps/ui/tsconfig.json"
  const play = "storybook:plays:apps/ui/src/e.stories.tsx#e--two"
  const tracedShot = "storybook:visual:apps/ui/src/e.stories.tsx#e--one"
  const sampledShot = "storybook:visual:apps/ui/src/f.stories.tsx#f--one"
  const planned = nightlyPlan(
    nightly({
      trace: [backend, ui, typecheck, lint, play, tracedShot],
      sample: [contract, sampledShot],
    }),
    new Map(),
  )
  assert.equal(planned.mode, "gate")
  assert.deepEqual(planned.rerun, [])
  assert.deepEqual(planned.jobs["package-tests"], { ids: [ui], rerun: [] })
  assert.deepEqual(
    planned.jobs["test-shards"].flatMap((entry) => entry.plan.ids).sort(),
    [backend, contract].sort(),
  )
  // The project checks run in the Project check times job, for their time.
  assert.deepEqual(planned.jobs["project-checks"], {
    ids: [lint, typecheck],
    rerun: [],
  })
  assert.equal(planned.jobs.typecheck, undefined)
  assert.equal(planned.outputs["project-checks"], "2")
  // The plays job renders the story of each play check and of each traced
  // screenshot check; the screenshots job checks both screenshots.
  assert.deepEqual(
    planned.jobs["storybook-plays"].flatMap((entry) => entry.plan.ids).sort(),
    [play, "storybook:plays:apps/ui/src/e.stories.tsx#e--one"].sort(),
  )
  assert.deepEqual(
    planned.jobs["storybook-visual"].flatMap((entry) => entry.plan.ids).sort(),
    [sampledShot, tracedShot].sort(),
  )
  assert.equal(planned.outputs["storybook-build"], "true")
  // A plan with no check starts no check job.
  const empty = nightlyPlan(nightly(), new Map())
  assert.equal(empty.mode, "gate")
  assert.deepEqual(empty.outputs, {})
  // A full plan (a run by hand, no previous trace, or 7 days) runs every job.
  const full = nightlyPlan(nightly({ full: "a person asked" }), new Map())
  assert.equal(full.mode, "full")
  assert.deepEqual(full.outputs, {})
  assert.throws(() => nightlyPlan({ schemaVersion: 2 }, new Map()))
})

test("a nightly plan renders each story in one Storybook shard only", () => {
  // Each render of a story records all its check ids in the trace of its
  // shard, and `trace.mjs merge` rejects an id in two traces. So a story
  // with a required check and a traced screenshot check is one plan id.
  const stories = ["a", "b", "c", "d"].map(
    (name) => `apps/ui/src/${name}.stories.tsx#${name}--one`,
  )
  const required = stories.map((story) => `storybook:required:${story}`)
  const shots = stories.map((story) => `storybook:visual:${story}`)
  const planned = nightlyPlan(
    nightly({ trace: [...required, ...shots] }),
    new Map(required.map((id) => [id, 400])),
  )
  const shards = planned.jobs["storybook-plays"]
  assert.ok(shards.length > 1)
  assert.deepEqual(shards.flatMap((entry) => entry.plan.ids).sort(), required)
})

test("the CLI writes the nightly plan and the outputs of the plan job", () => {
  const directory = inputs({
    "factory-plan.json": nightly({ trace: [ui] }),
    "merge-gate.json": config(),
  })
  const out = join(directory, "out")
  const outputs = join(directory, "outputs.txt")
  const run = spawnSync(
    process.execPath,
    [
      join(root, "scripts/checks/gate.mjs"),
      "nightly",
      "--config",
      join(directory, "merge-gate.json"),
      "--plan",
      join(directory, "factory-plan.json"),
      "--trace",
      join(directory, "no-previous-trace.json.gz"),
      "--out",
      out,
      "--github-output",
      outputs,
    ],
    { cwd: root, encoding: "utf8" },
  )
  assert.equal(run.status, 0, run.stderr)
  const planned = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"))
  assert.deepEqual(planned.jobs["package-tests"], { ids: [ui], rerun: [] })
  assert.match(readFileSync(outputs, "utf8"), /^mode=gate\n/m)
  assert.match(readFileSync(outputs, "utf8"), /^package-tests=1\n/m)
})
