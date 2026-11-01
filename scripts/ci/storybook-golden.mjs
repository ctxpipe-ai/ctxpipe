import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { browserTrace, storyCheck } from "../checks/storybook.mjs"
import { writeTrace } from "../checks/trace.mjs"
import {
  selectGoldenStories,
  selectPlayStories,
  shardStories,
} from "./storybook-golden-select.mjs"
import {
  playStories,
  serveStatic,
  staticDir,
  waitFor,
} from "./storybook-play.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const ui = join(root, "apps/ui")

const fail = (message) => {
  throw new Error(message)
}

const run = (command, args, cwd = ui) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" })
  if (result.error || result.signal)
    fail(`${command} did not finish: ${result.error?.message ?? result.signal}`)
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`)
}

// STORYBOOK_PLAYS=all runs every story that has a play function. The default
// runs the required golden set. STORYBOOK_SHARD=i/n keeps every n-th story.
// STORYBOOK_ONLY=a,b keeps stories whose id or file path contains a, or b.
// --trace also writes trace.json.gz next to results.json: the browser lines
// and the MSW handlers of each story (scripts/checks/README.md). It is data
// only and does not change a result.
const mode = process.env.STORYBOOK_PLAYS === "all" ? "all" : "golden"
const trace = process.argv.slice(2).includes("--trace")

const chosenStories = (index) => {
  try {
    const stories =
      mode === "all" ? selectPlayStories(index) : selectGoldenStories(index)
    const only = (process.env.STORYBOOK_ONLY ?? "").split(",").filter(Boolean)
    const filtered = only.length
      ? stories.filter((story) =>
          only.some(
            (part) =>
              story.id.includes(part) || story.importPath.includes(part),
          ),
        )
      : stories
    return shardStories(filtered, process.env.STORYBOOK_SHARD)
  } catch (error) {
    fail(error.message)
  }
}

try {
  run(
    process.execPath,
    [
      join(root, "scripts/ci/check-allowlist-history.mjs"),
      "scripts/ci/failures/storybook-golden.json",
    ],
    root,
  )
  const output = resolve(
    root,
    process.env.CI_TEST_RESULTS_DIR ?? ".ci-results",
    mode === "all" ? "storybook-plays" : "storybook-golden",
  )
  mkdirSync(output, { recursive: true })
  const report = join(output, "results.json")
  rmSync(report, { force: true })
  const url = process.env.STORYBOOK_URL
  let server
  if (!url) {
    if (process.env.SKIP_STORYBOOK_BUILD !== "1")
      run("pnpm", ["--filter", "@ctxpipe/ui", "build-storybook"], root)
    server = await serveStatic(
      staticDir,
      Number(process.env.STORYBOOK_PORT ?? 6007),
    )
  }
  const storybookUrl =
    url ?? `http://127.0.0.1:${process.env.STORYBOOK_PORT ?? 6007}`
  await waitFor(`${storybookUrl}/index.json`)
  const stories = chosenStories(
    await (await fetch(`${storybookUrl}/index.json`)).json(),
  )
  const suites = new Map()
  // One result record for each story (scripts/checks/schema/result.v1.schema.json).
  const records = []
  const durations = {}
  const traced = []
  const tracer = trace ? browserTrace(staticDir) : undefined
  let passed = 0
  let failed = 0
  await playStories(
    storybookUrl,
    stories,
    (story, { error, durationMs, coverage, mocks }) => {
      const file = resolve(ui, story.importPath.replace(/^\.\//, ""))
      const suite = suites.get(file) ?? {
        name: file,
        status: "passed",
        assertionResults: [],
      }
      suites.set(file, suite)
      if (tracer) {
        const record = tracer.check(story, durationMs, coverage, mocks)
        if (record) traced.push(record)
        else durations[storyCheck(story).id] = durationMs
      }
      const status = error ? "failed" : "passed"
      records.push({
        schemaVersion: 1,
        id: storyCheck(story).id,
        status,
        durationMs: Math.round(durationMs),
        cases: [
          {
            name: story.exportName,
            status,
            durationMs: Math.round(durationMs),
          },
        ],
      })
      if (error) {
        failed += 1
        suite.status = "failed"
        suite.assertionResults.push({
          status: "failed",
          fullName: story.exportName,
          failureMessages: [error],
        })
        process.stderr.write(`FAIL ${story.exportName}\n${error}\n`)
      } else {
        passed += 1
        suite.assertionResults.push({
          status: "passed",
          fullName: story.exportName,
        })
        process.stdout.write(`PASS ${story.exportName}\n`)
      }
    },
    trace,
  )
  await new Promise((resolveClose) => {
    if (!server) {
      resolveClose()
      return
    }
    server.close(resolveClose)
  })
  // A trace is data only: an error here never changes a result.
  if (tracer)
    try {
      tracer.report()
      writeTrace(join(output, "trace.json.gz"), traced, undefined, durations)
    } catch (error) {
      process.stderr.write(`No trace written: ${error.message}\n`)
    }
  const results = {
    numTotalTests: stories.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [...suites.values()],
  }
  writeFileSync(report, `${JSON.stringify(results, null, 2)}\n`)
  // For the merge gate and the result store. Data only, as the trace.
  try {
    writeFileSync(
      join(output, "records.ndjson"),
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    )
  } catch (error) {
    process.stderr.write(`No result records written: ${error.message}\n`)
  }
  writeFileSync(
    join(output, "inventory.json"),
    `${JSON.stringify(
      [...suites.keys()].map((file) =>
        relative(ui, file).replaceAll("\\", "/"),
      ),
      null,
      2,
    )}\n`,
  )
  const status = failed ? 1 : 0
  run(
    process.execPath,
    [
      join(root, "scripts/ci/check-test-report.mjs"),
      report,
      join(root, "scripts/ci/failures/storybook-golden.json"),
      String(status),
      join(output, "inventory.json"),
    ],
    ui,
  )
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  // The static server and the browser keep the event loop alive, so a plain
  // exit code would hang the job until its timeout.
  process.exit(1)
}
