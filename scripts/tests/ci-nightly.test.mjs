import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, afterEach, before, test } from "node:test"
import { fileURLToPath } from "node:url"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { parse } from "yaml"

import {
  minutesText,
  nightlyChanged,
  nightlyMinutes,
  nightlyTickets,
} from "../ci/nightly.mjs"

// GitHub and Linear are outside services: msw answers their HTTP calls.
const server = setupServer()
before(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => server.resetHandlers())
after(() => server.close())

const repo = "example-org/example-repo"
const sha = "a".repeat(40)

// The last successful scheduled run of ci.yaml on main has this commit.
const lastNightly = (headSha) =>
  http.get(
    `https://api.github.com/repos/${repo}/actions/workflows/ci.yaml/runs`,
    ({ request }) => {
      const query = new URL(request.url).searchParams
      assert.equal(query.get("event"), "schedule")
      assert.equal(query.get("branch"), "main")
      assert.equal(query.get("status"), "success")
      return HttpResponse.json({
        workflow_runs: headSha ? [{ head_sha: headSha }] : [],
      })
    },
  )

test("an unchanged main skips the nightly run", async () => {
  server.use(lastNightly(sha))
  assert.equal(await nightlyChanged({ repo, sha, token: "t" }), false)
})

test("a new commit on main, or no successful nightly run yet, runs the nightly run", async () => {
  server.use(lastNightly("b".repeat(40)))
  assert.equal(await nightlyChanged({ repo, sha, token: "t" }), true)
  server.use(lastNightly(undefined))
  assert.equal(await nightlyChanged({ repo, sha, token: "t" }), true)
})

// The entries of the unstable list without a valid `since` date, or with a
// date more than 7 days before `today` (YYYY-MM-DD). The test of the
// committed list below is the 7-day check of CI.
const overdueEntries = (stories, today) =>
  stories.filter(
    (entry) =>
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.since ?? "") ||
      // A date that does not exist (2026-11-31) is not a date.
      new Date(Date.parse(entry.since) || 0).toISOString().slice(0, 10) !==
        entry.since ||
      Date.parse(today) - Date.parse(entry.since) > 7 * 86_400_000,
  )

test("an unstable entry older than 7 days, or without a date, is overdue", () => {
  const entry = (since) => ({
    id: `x--${since}`,
    reason: "r",
    ticket: "CTX-1",
    since,
  })
  assert.deepEqual(
    overdueEntries(
      [
        entry("2026-11-03"),
        entry("2026-11-02"),
        entry(undefined),
        entry("soon"),
        entry("2026-11-31"),
      ],
      "2026-11-10",
    ).map((item) => item.since),
    ["2026-11-02", undefined, "soon", "2026-11-31"],
  )
})

// The artifact folders of a nightly run: records of the first run, records
// of the rerun, and the visual manifest of the first run.
function results({
  visual = [],
  plays = [],
  visualRerun = [],
  playsRerun = [],
}) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-nightly-"))
  const write = (path, records) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(
      join(root, path),
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    )
  }
  write(
    "test-results-storybook-visual-1/storybook-visual/records.ndjson",
    visual,
  )
  write(
    "test-results-storybook-visual-1/storybook-visual/rerun/rerun.ndjson",
    visualRerun,
  )
  write("storybook-plays-results-2/records.ndjson", plays)
  write("storybook-plays-results-2/rerun/rerun.ndjson", playsRerun)
  mkdirSync(join(root, "test-results-storybook-visual-1/visual-first-run"))
  writeFileSync(
    join(
      root,
      "test-results-storybook-visual-1/visual-first-run/manifest.json",
    ),
    JSON.stringify({
      stories: [
        {
          id: "card--empty",
          baseline:
            "apps/ui/src/x/screenshots/Card.Empty.desktop.screenshot.png",
        },
        {
          id: "card--empty",
          baseline:
            "apps/ui/src/x/screenshots/Card.Empty.mobile.screenshot.png",
        },
        {
          id: "menu--open",
          baseline:
            "apps/ui/src/y/screenshots/Menu.Open.desktop.screenshot.png",
        },
        // Not a screenshot baseline: the job never removes it.
        { id: "card--empty", baseline: ".github/workflows/ci.yaml" },
        {
          id: "card--empty",
          baseline: "apps/ui/../../x/screenshots/A.B.desktop.screenshot.png",
        },
      ],
    }),
  )
  return root
}

const visualId = (story) =>
  `storybook:visual:apps/ui/src/x/Card.stories.tsx#${story}`
const requiredId = (story) =>
  `storybook:required:apps/ui/src/y/Menu.stories.tsx#${story}`
const playId = (story) =>
  `storybook:plays:apps/ui/src/x/Card.stories.tsx#${story}`

// A run with the given jobs and two artifacts, and a Linear workspace with
// the team CTX. `open` maps an issue title to an open issue. Records each
// Linear call by its operation name.
function nightly({ jobs = [], open = {} } = {}) {
  const calls = []
  server.use(
    http.get(`https://api.github.com/repos/${repo}/actions/runs/7/jobs`, () =>
      HttpResponse.json({ jobs }),
    ),
    http.get(
      `https://api.github.com/repos/${repo}/actions/runs/7/artifacts`,
      () =>
        HttpResponse.json({
          artifacts: [
            { id: 11, name: "test-results-storybook-visual-1" },
            { id: 12, name: "storybook-plays-results-2" },
          ],
        }),
    ),
    http.post("https://api.linear.app/graphql", async ({ request }) => {
      assert.equal(request.headers.get("authorization"), "linear-test-key")
      const { query, variables } = await request.json()
      const operation = /^(?:query|mutation) (\w+)/.exec(query)[1]
      calls.push({ operation, variables })
      if (operation === "Setup")
        return HttpResponse.json({
          data: {
            teams: {
              nodes: [
                {
                  id: "team-1",
                  states: {
                    nodes: [
                      { id: "state-todo", name: "Todo" },
                      { id: "state-triage", name: "Triage" },
                    ],
                  },
                },
              ],
            },
            issueLabels: { nodes: [{ id: "label-ready" }] },
            issue: { id: "epic-1" },
          },
        })
      if (operation === "Open")
        return HttpResponse.json({
          data: {
            issues: {
              nodes: open[variables.title] ? [open[variables.title]] : [],
            },
          },
        })
      if (operation === "Create")
        return HttpResponse.json({
          data: {
            issueCreate: {
              success: true,
              issue: {
                identifier: "CTX-9001",
                url: "https://linear.app/x/CTX-9001",
              },
            },
          },
        })
      if (operation === "Comment")
        return HttpResponse.json({ data: { commentCreate: { success: true } } })
      return HttpResponse.json({ errors: [{ message: "unknown" }] })
    }),
  )
  return calls
}

const run = (dir, today = "2026-11-10") =>
  nightlyTickets({
    results: dir,
    repo,
    runId: "7",
    sha,
    server: "https://github.com",
    token: "t",
    linearKey: "linear-test-key",
    today,
  })

test("a check that fails and then passes in its rerun opens one ticket for each story", async () => {
  const calls = nightly()
  const unstable = await run(
    results({
      visual: [
        { id: visualId("card--empty"), status: "failed" },
        { id: visualId("menu--open"), status: "failed" },
        { id: visualId("card--steady"), status: "passed" },
        { id: visualId("card--broken"), status: "failed" },
      ],
      visualRerun: [
        { id: visualId("card--empty"), status: "passed" },
        { id: visualId("menu--open"), status: "passed" },
        // It failed again: a real failure, not a flake.
        { id: visualId("card--broken"), status: "failed" },
      ],
      plays: [
        { id: playId("card--empty"), status: "failed" },
        { id: requiredId("menu--closed"), status: "failed" },
        // A test that is not a screenshot or play check.
        { id: "vitest:ui:apps/ui/src/a.test.ts", status: "failed" },
      ],
      playsRerun: [
        { id: playId("card--empty"), status: "passed" },
        { id: requiredId("menu--closed"), status: "passed" },
        { id: "vitest:ui:apps/ui/src/a.test.ts", status: "passed" },
      ],
    }),
  )
  assert.deepEqual(unstable, [])
  const created = calls.filter((call) => call.operation === "Create")
  assert.deepEqual(
    created.map((call) => call.variables.input.title),
    [
      "Flaky story card--empty",
      "Flaky story menu--closed",
      "Flaky story menu--open",
    ],
  )
  const card = created[0].variables.input
  assert.equal(card.teamId, "team-1")
  assert.equal(card.stateId, "state-todo")
  assert.deepEqual(card.labelIds, ["label-ready"])
  assert.equal(card.parentId, "epic-1")
  for (const text of [
    visualId("card--empty"),
    playId("card--empty"),
    "https://github.com/example-org/example-repo/actions/runs/7",
    "https://github.com/example-org/example-repo/actions/runs/7/artifacts/11",
    "https://github.com/example-org/example-repo/actions/runs/7/artifacts/12",
    "visual-first-run/card--empty/",
  ])
    assert.ok(card.description.includes(text), text)
})

test("a second flake of a story comments on its ticket and gives the unstable entry with that ticket", async () => {
  const calls = nightly({
    open: {
      "Flaky story card--empty": { id: "issue-1", identifier: "CTX-4242" },
    },
  })
  const unstable = await run(
    results({
      visual: [{ id: visualId("card--empty"), status: "failed" }],
      visualRerun: [{ id: visualId("card--empty"), status: "passed" }],
    }),
  )
  assert.deepEqual(unstable, [
    {
      id: "card--empty",
      reason:
        "Flaked in two nightly runs (https://github.com/example-org/example-repo/actions/runs/7).",
      ticket: "CTX-4242",
      since: "2026-11-10",
      baselines: [
        "apps/ui/src/x/screenshots/Card.Empty.desktop.screenshot.png",
        "apps/ui/src/x/screenshots/Card.Empty.mobile.screenshot.png",
      ],
    },
  ])
  assert.equal(calls.filter((call) => call.operation === "Create").length, 0)
  const [comment] = calls.filter((call) => call.operation === "Comment")
  assert.equal(comment.variables.input.issueId, "issue-1")
  // The entry is valid in the list, and overdue only after 7 days.
  assert.deepEqual(overdueEntries(unstable, "2026-11-17"), [])
  assert.equal(overdueEntries(unstable, "2026-11-18").length, 1)
})

test("a failed job of the nightly run opens one ticket in Triage", async () => {
  const calls = nightly({
    jobs: [
      {
        name: "backend tests (shard 2/4)",
        conclusion: "failure",
        html_url: "https://github.com/j/1",
      },
      {
        name: "Trace",
        conclusion: "timed_out",
        html_url: "https://github.com/j/2",
      },
      // Its only failure is a flake, which has its own ticket.
      {
        name: "Storybook screenshots (1/4)",
        conclusion: "failure",
        html_url: "https://github.com/j/5",
      },
      {
        name: "Tests",
        conclusion: "success",
        html_url: "https://github.com/j/3",
      },
      {
        name: "Nightly tickets",
        conclusion: null,
        html_url: "https://github.com/j/4",
      },
    ],
  })
  assert.deepEqual(
    await run(
      results({
        visual: [{ id: visualId("card--empty"), status: "failed" }],
        visualRerun: [{ id: visualId("card--empty"), status: "passed" }],
      }),
    ),
    [],
  )
  const created = calls.filter(
    (call) =>
      call.operation === "Create" &&
      !call.variables.input.title.startsWith("Flaky story"),
  )
  assert.equal(created.length, 1)
  const { input } = created[0].variables
  assert.equal(input.stateId, "state-triage")
  assert.equal(input.title, "Nightly CI run failed on aaaaaaa")
  for (const text of [
    "backend tests (shard 2/4): https://github.com/j/1",
    "Trace: https://github.com/j/2",
    "Run: https://github.com/example-org/example-repo/actions/runs/7",
  ])
    assert.ok(input.description.includes(text), text)
  assert.ok(!input.description.includes("Tests:"))
  assert.ok(!input.description.includes("Storybook screenshots"))
})

test("a failed job of an unchanged main that failed before comments on the open ticket of the commit", async () => {
  const calls = nightly({
    jobs: [
      {
        name: "Trace",
        conclusion: "failure",
        html_url: "https://github.com/j/2",
      },
    ],
    open: {
      "Nightly CI run failed on aaaaaaa": { id: "issue-7", identifier: "CTX-77" },
    },
  })
  await run(results({}))
  assert.equal(calls.filter((call) => call.operation === "Create").length, 0)
  const [comment] = calls.filter((call) => call.operation === "Comment")
  assert.equal(comment.variables.input.issueId, "issue-7")
  assert.ok(comment.variables.input.body.includes("Trace: https://github.com/j/2"))
})

test("a run with no flake and no failed job calls no Linear API", async () => {
  const calls = nightly({ jobs: [{ name: "Tests", conclusion: "success" }] })
  assert.deepEqual(await run(results({})), [])
  assert.deepEqual(calls, [])
})

test("the tickets command without the Linear key gives an error annotation and fails", () => {
  const env = { ...process.env }
  delete env.LINEAR_API_KEY
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../ci/nightly.mjs", import.meta.url)),
      "tickets",
      tmpdir(),
    ],
    { env, encoding: "utf8" },
  )
  assert.equal(result.status, 1)
  assert.match(result.stdout, /^::error::LINEAR_API_KEY is not set/m)
})

test("the committed unstable list has no entry older than 7 days", () => {
  const list = JSON.parse(
    readFileSync(
      new URL("../ci/visual-unstable-stories.json", import.meta.url),
      "utf8",
    ),
  )
  const overdue = overdueEntries(
    list.stories,
    new Date().toISOString().slice(0, 10),
  )
  assert.deepEqual(
    overdue,
    [],
    "Fix the story of each entry (its ticket) and remove the entry.",
  )
})

test("each job of the nightly run waits for the job Nightly change and does not start on an unchanged main", () => {
  const { jobs } = parse(
    readFileSync(
      new URL("../../.github/workflows/ci.yaml", import.meta.url),
      "utf8",
    ),
  )
  const needs = (job) => [jobs[job].needs ?? []].flat()
  // A job stops on an unchanged main when its `if:` reads the output of
  // Nightly change, or needs the success of a job that stops.
  const stops = (job) =>
    String(jobs[job].if).includes("needs.nightly-change.outputs.run") ||
    needs(job).some(
      (need) =>
        String(jobs[job].if).includes(`needs.${need}.result == 'success'`) &&
        stops(need),
    )
  const scheduled = Object.keys(jobs).filter(
    (job) =>
      job !== "nightly-change" &&
      /github\.event_name == 'schedule'/.test(String(jobs[job].if)),
  )
  assert.ok(scheduled.length > 10, scheduled.join(", "))
  for (const job of scheduled) {
    assert.ok(stops(job), `${job} starts on an unchanged main`)
    if (String(jobs[job].if).includes("needs.nightly-change"))
      assert.ok(needs(job).includes("nightly-change"), job)
  }
  // Nightly tickets reads the jobs of the run when every other job has
  // ended, and it runs also when Nightly change failed (no output).
  for (const job of [...scheduled, "nightly-change", "non-portable-checks"])
    if (job !== "nightly-tickets")
      assert.ok(needs("nightly-tickets").includes(job), job)
  assert.match(
    jobs["nightly-tickets"].if,
    /needs\.nightly-change\.outputs\.run != 'false'/,
  )
  // The job with the Linear key downloads only the artifacts that the
  // Storybook shards name by id, never by a name or a pattern.
  const downloads = jobs["nightly-tickets"].steps.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  )
  assert.ok(downloads.length > 0)
  for (const step of downloads)
    assert.deepEqual(Object.keys(step.with).sort(), ["artifact-ids", "path"])
  for (const job of ["storybook-plays", "storybook-visual"])
    assert.deepEqual(Object.keys(jobs[job].outputs), [
      "artifact-1",
      "artifact-2",
      "artifact-3",
      "artifact-4",
    ])
})

test("the runner minutes compare the run with the last full nightly run of main", async () => {
  const at = (minutes) => new Date(Date.UTC(2026, 10, 10, 2, minutes)).toISOString()
  const jobs = { 7: [[0, 10], [0, 5]], 6: [[0, 30]], 5: [[0, 200]] }
  server.use(
    http.get(
      `https://api.github.com/repos/${repo}/actions/runs/:id/jobs`,
      ({ params }) =>
        HttpResponse.json({
          jobs: [
            ...jobs[params.id].map(([start, end]) => ({
              started_at: at(start),
              completed_at: at(end),
            })),
            // A job that did not end yet does not count.
            { started_at: at(0), completed_at: null },
          ],
        }),
    ),
    http.get(
      `https://api.github.com/repos/${repo}/actions/workflows/ci.yaml/runs`,
      ({ request }) => {
        // The query names the event, so push runs never fill the page.
        const event = new URL(request.url).searchParams.get("event")
        const runs = {
          schedule: [
            { id: 7, created_at: at(30) },
            { id: 6, html_url: "u6", created_at: at(20) },
          ],
          workflow_dispatch: [{ id: 5, html_url: "u5", created_at: at(10) }],
        }[event]
        assert.ok(runs, event)
        return HttpResponse.json({ workflow_runs: runs })
      },
    ),
    http.get(
      `https://api.github.com/repos/${repo}/actions/runs/:id/artifacts`,
      ({ params }) =>
        HttpResponse.json({
          artifacts: {
            // An incremental run: a plan, no full marker.
            6: [{ name: `trace-${sha}` }, { name: "nightly-plan" }],
            // A full run.
            5: [{ name: `trace-${sha}` }, { name: "nightly-plan" }, { name: "nightly-full" }],
          }[params.id],
        }),
    ),
  )
  const minutes = await nightlyMinutes({ repo, runId: 7, token: "t" })
  assert.equal(minutes.current, 15)
  assert.deepEqual(
    [minutes.full.id, minutes.full.minutes, minutes.full.url],
    [5, 200, "u5"],
  )
  assert.match(
    minutesText(minutes),
    /^Runner minutes: 15 in this run .* against 200 in the last full nightly run \(u5, 2026-11-10\)\.$/,
  )
  assert.match(minutesText({ current: 3 }), /No full nightly run of main/)
})

test("the nightly run plans on main, traces its plan, and the Results writer always audits the sample of the plan", () => {
  const { jobs } = parse(
    readFileSync(
      new URL("../../.github/workflows/ci.yaml", import.meta.url),
      "utf8",
    ),
  )
  const text = (job) => JSON.stringify(jobs[job])
  // The plan job holds the role of the result store, which trusts only main,
  // and runs no repository script.
  const plan = jobs["nightly-plan"]
  assert.match(plan.if, /github\.ref == 'refs\/heads\/main'/)
  assert.match(text("nightly-plan"), /check-results-ci-writer/)
  assert.doesNotMatch(text("nightly-plan"), /node scripts|pnpm/)
  assert.match(text("nightly-plan"), /--exclude-lane vercel/)
  assert.match(text("nightly-plan"), /workflow_dispatch \]; then args\+=\(--full\)/)
  // The plan job of the gate puts its checks into the jobs of the run.
  assert.match(text("merge-gate-plan"), /gate\.mjs nightly/)
  // The planned jobs trace their checks.
  for (const job of ["test-shards", "package-tests"])
    assert.match(text(job), /TRACE":"\$\{\{ github\.event_name != 'pull_request' && '\.ci-results\/selected' \|\| '' \}\}/, job)
  assert.match(text("storybook-plays"), /STORYBOOK_IDS=.*storybook-plays\.mjs --trace/)
  // The Trace job combines the trace of the run with the previous trace.
  assert.match(text("trace"), /trace combine --plan/)
  assert.match(text("trace"), /sha256sum --check --strict/)
  // The Results writer never runs factory store without the plan.
  const store = jobs["results-writer"].steps.find(
    (step) => step.id === "store",
  ).run
  assert.match(store, /--plan "\$RUNNER_TEMP\/nightly\/plan\.json"/)
  assert.ok(
    store.indexOf('[ ! -f "$RUNNER_TEMP/nightly/plan.json" ]') <
      store.indexOf("factory\" store"),
  )
  assert.match(store, /exit 1/)
  assert.match(store, /NOT AUDITED\|AUDIT SAMPLE FAILED/)
  // A run without a project check has no project artifact: the writer
  // downloads it by a pattern, which does not fail when nothing matches.
  const projects = jobs["results-writer"].steps.find((step) =>
    String(step.with?.pattern ?? step.with?.name).includes("lane-trace-projects"),
  )
  assert.equal(projects.with.pattern, "lane-trace-projects")
  // The codesearch job runs the planned files of an incremental run, and the
  // codesearch and project jobs run their failed checks once more.
  assert.match(text("codesearch"), /files\+=\(--node/)
  assert.match(text("codesearch"), /files\+=\(--bun/)
  for (const job of ["codesearch", "project-checks"])
    assert.match(text(job), /rerun-failed\.mjs/, job)
  // An incremental run builds no image: an image build has no key.
  assert.doesNotMatch(
    String(jobs["production-builds"].if),
    /'schedule' \|\|\s*\(needs\.merge-gate-plan/,
  )
  // Nightly tickets shows the runner minutes.
  assert.ok(
    jobs["nightly-tickets"].steps.some(
      (step) => step.run === "node scripts/ci/nightly.mjs minutes",
    ),
  )
})
