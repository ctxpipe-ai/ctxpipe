import { spawnSync } from "node:child_process"
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { lanes, listChecks, root } from "./lanes.mjs"

// Runs the given check ids and writes one result record per id
// (schema/result.v1.schema.json) as NDJSON. Usage:
//   run.mjs [ids-file] [--output <file>]
// Without ids-file, the ids come from stdin, one per line.
// This is the subset path. It does not compare the executed files with the
// full CI inventory or the failure baseline; test-suite.mjs still does that.
try {
  const args = process.argv.slice(2)
  const at = args.indexOf("--output")
  const output = at === -1 ? undefined : args[at + 1]
  const positional = args.filter((_, index) => index !== at && index !== at + 1)
  if ((at !== -1 && !output) || positional.length > 1)
    throw new Error("Usage: run.mjs [ids-file] [--output <file>]")
  const ids = [
    ...new Set(
      readFileSync(positional[0] ?? 0, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ]
  if (output) writeFileSync(output, "")
  const emit = (record) => {
    const line = `${JSON.stringify(record)}\n`
    if (output) writeFileSync(output, line, { flag: "a" })
    else process.stdout.write(line)
  }
  const known = new Map((await listChecks()).checks.map((c) => [c.id, c]))
  const groups = new Map()
  let failed = false
  for (const id of ids) {
    const check = known.get(id)
    if (!check) {
      emit({
        id,
        status: "error",
        durationMs: 0,
        cases: [],
        message: "Unknown check id",
      })
      failed = true
      continue
    }
    groups.set(check.lane, [...(groups.get(check.lane) ?? []), check])
  }
  const results = resolve(root, ".ci-results", "checks")
  mkdirSync(results, { recursive: true })
  // One lane at a time: backend files share one database and run in series.
  for (const [lane, checks] of groups) {
    const { directory, runtime } = lanes[lane]
    const cwd = join(root, directory)
    const log = join(results, `${lane}.log`)
    const report = join(results, `${lane}.json`)
    rmSync(report, { force: true })
    writeFileSync(log, "")
    // The Vitest output goes to the log; stdout carries only result records.
    const logged = (command, commandArgs, options = {}) => {
      writeFileSync(log, `$ ${command} ${commandArgs.join(" ")}\n`, {
        flag: "a",
      })
      const fd = openSync(log, "a")
      try {
        return spawnSync(command, commandArgs, {
          cwd,
          stdio: ["ignore", fd, fd],
          ...options,
        })
      } finally {
        closeSync(fd)
      }
    }
    const require = createRequire(join(cwd, "package.json"))
    let setup
    if (lane === "cli")
      setup = logged(process.execPath, [
        require.resolve("typescript/bin/tsc"),
        "-p",
        "tsconfig.build.json",
      ])
    if (lane === "aws-cdk")
      setup = logged(process.execPath, [
        join(root, "packages/aws-cdk/scripts/stamp-image-tag.mjs"),
      ])
    let suites = new Map()
    let message = setup?.status ? `${lane} setup failed` : undefined
    if (!message) {
      const vitest = join(
        dirname(require.resolve("vitest/package.json")),
        "vitest.mjs",
      )
      const run = logged(
        runtime === "bun" ? "bun" : process.execPath,
        [
          vitest,
          "run",
          ...checks.map(({ file }) => relative(directory, file)),
          "--reporter=default",
          "--reporter=json",
          `--outputFile=${report}`,
        ],
        { timeout: 2_700_000 },
      )
      try {
        const parsed = JSON.parse(readFileSync(report, "utf8"))
        suites = new Map(
          parsed.testResults.map((suite) => [
            relative(realpathSync(root), realpathSync(suite.name)).replaceAll(
              "\\",
              "/",
            ),
            suite,
          ]),
        )
      } catch {
        message = `Vitest wrote no report (${run.error?.message ?? run.signal ?? `exit ${run.status}`})`
      }
    }
    for (const { id, file } of checks) {
      const suite = suites.get(file)
      const cases = (suite?.assertionResults ?? []).map((assertion) => ({
        name: assertion.fullName,
        status:
          assertion.status === "passed" || assertion.status === "failed"
            ? assertion.status
            : "skipped",
        durationMs: Math.round(assertion.duration ?? 0),
        ...(assertion.failureMessages?.length
          ? { message: assertion.failureMessages.join("\n") }
          : {}),
      }))
      const status = !suite
        ? "error"
        : suite.message || !cases.length
          ? "error"
          : cases.some((c) => c.status === "failed")
            ? "failed"
            : cases.every((c) => c.status === "skipped")
              ? "skipped"
              : "passed"
      if (status === "failed" || status === "error") failed = true
      emit({
        id,
        status,
        durationMs: suite
          ? Math.max(0, Math.round(suite.endTime - suite.startTime))
          : 0,
        cases,
        log: relative(root, log),
        ...(status === "error"
          ? { message: suite?.message || message || "Suite did not run" }
          : {}),
      })
    }
  }
  process.exitCode = failed ? 1 : 0
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
