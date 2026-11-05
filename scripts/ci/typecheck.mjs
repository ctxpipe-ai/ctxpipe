import { spawnSync } from "node:child_process"
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

try {
  const [project, baselinePath, reportPath, ...extra] = process.argv.slice(2)
  if (!project || !baselinePath || extra.length) {
    throw new Error(
      "Usage: typecheck.mjs tsconfig.json baseline.json [observed-report.json]",
    )
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
  if (baseline.version !== 1 || !Array.isArray(baseline.diagnostics)) {
    throw new Error("Invalid diagnostic baseline")
  }
  // The message text belongs to the checker that wrote it, so an allowance
  // compares only the file, the code and the count. The message is for the
  // report.
  const identity = ({ file, code }) => JSON.stringify([file, code])
  const allowed = new Map()
  for (const item of baseline.diagnostics) {
    if (
      typeof item.file !== "string" ||
      !Number.isInteger(item.code) ||
      !Number.isInteger(item.count) ||
      item.count < 1
    ) {
      throw new Error("Invalid diagnostic entry")
    }
    // Entries that differ only in the message add up, as in the history check.
    allowed.set(identity(item), (allowed.get(identity(item)) ?? 0) + item.count)
  }

  const configPath = resolve(project)
  const repository = fileURLToPath(new URL("../../", import.meta.url)).replace(
    /\/$/,
    "",
  )
  // `bun check` reads the same tsconfig.json as tsc and reports the same
  // errors. It runs in the directory of the project, so a file path is
  // relative to that directory. It needs no build info: a full run takes
  // seconds. `--all` lists every error (without it, Bun groups identical
  // errors above 50). `--no-script` runs the checker even when a package.json
  // has a `check` script. Bun prints the errors to stdout and the summary to
  // stderr.
  const run = spawnSync(
    "bun",
    [
      "check",
      "--no-script",
      "--no-pretty",
      "--all",
      "-p",
      basename(configPath),
    ],
    {
      // The real path: Bun prints a path relative to its real working
      // directory, and a symlinked directory would give a ../ path.
      cwd: realpathSync(dirname(configPath)),
      // In GitHub Actions, Bun also prints a `::error` annotation line for
      // each error. This script parses the plain lines and prints the
      // annotations itself, through the CI problem matcher.
      env: { ...process.env, GITHUB_ACTIONS: undefined },
      encoding: "utf8",
      maxBuffer: 1 << 28,
    },
  )
  if (run.error) throw run.error
  // A diagnostic starts with `file(line,col): error TSnnnn: text`, or with
  // `error TSnnnn: text` when it has no file (a tsconfig error). The lines
  // that follow it and start with a space are the rest of its message.
  const diagnostics = []
  const unparsed = []
  for (const line of run.stdout.split("\n")) {
    const header = /^(?:(.+?)\(\d+,\d+\): )?error TS(\d+): (.*)$/.exec(line)
    if (header) {
      diagnostics.push({
        file: header[1] ?? "<compiler>",
        code: Number(header[2]),
        lines: [header[3]],
        text: line,
      })
    } else if (diagnostics.length && /^\s+\S/.test(line)) {
      diagnostics.at(-1).lines.push(line)
      diagnostics.at(-1).text += `\n${line}`
    } else if (line.trim()) {
      unparsed.push(line)
    }
  }
  const output = `${run.stdout}${run.stderr}`
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(
      `bun check failed (${run.signal ?? `exit ${run.status}`})\n${output}`,
    )
  }
  // Never a false pass: the summary that Bun prints on stderr must agree with
  // the diagnostics that this script parsed and with the exit code. Bun stops
  // before it checks any file when the configuration or a file has a syntax
  // error. Such a run lists only those errors, so a new type error would
  // stay hidden.
  const reject = (reason) => {
    throw new Error(`bun check output is not trusted: ${reason}\n${output}`)
  }
  if (unparsed.length)
    reject(`it has a line that is not a diagnostic: ${unparsed[0]}`)
  const summary =
    /^(?:Found ([\d,]+) errors?(?: in [\d,]+ files?)?, checked ([\d,]+) files?|(?:✓ )?No type errors in ([\d,]+) files?)/m.exec(
      run.stderr,
    )
  if (!summary) reject("it has no summary line")
  if (/Stopped before type checking/.test(output))
    reject("Bun stopped before it checked the files")
  const reported = Number((summary[1] ?? "0").replaceAll(",", ""))
  const checked = Number((summary[2] ?? summary[3]).replaceAll(",", ""))
  if (checked === 0) reject("Bun checked 0 files")
  if (reported !== diagnostics.length)
    reject(
      `the summary has ${reported} error(s) and the script parsed ${diagnostics.length}`,
    )
  if (run.status !== (reported > 0 ? 1 : 0))
    reject(`exit ${run.status} does not match ${reported} error(s)`)
  const observed = new Map()
  const keys = new Map()
  for (const diagnostic of diagnostics) {
    const item = {
      file: diagnostic.file.replaceAll("\\", "/"),
      code: diagnostic.code,
      message: diagnostic.lines
        .join("\n")
        .replaceAll(repository, "<repo>")
        .replaceAll(realpathSync(repository), "<repo>"),
      count: 1,
    }
    keys.set(diagnostic, identity(item))
    const previous = observed.get(identity(item))
    if (previous) previous.count += 1
    else observed.set(identity(item), item)
  }
  if (reportPath) {
    writeFileSync(
      reportPath,
      `${JSON.stringify({ version: 1, diagnostics: [...observed.values()] }, null, 2)}\n`,
    )
  }
  // Print only the diagnostics that do not match the allowance. The CI
  // problem matcher makes each printed diagnostic an error annotation, so
  // acknowledged diagnostics in the output hide the true cause of a failure.
  for (const diagnostic of diagnostics) {
    const key = keys.get(diagnostic)
    if (allowed.get(key) !== observed.get(key).count)
      process.stdout.write(`${diagnostic.text}\n`)
  }
  let failed = false
  let acknowledged = 0
  for (const [key, item] of observed) {
    if (allowed.get(key) !== item.count) {
      process.stdout.write(
        `UNEXPECTED ${item.file} TS${item.code}: observed ${item.count}, allowed ${allowed.get(key) ?? 0}\n`,
      )
      failed = true
    } else acknowledged += item.count
  }
  for (const [key, count] of allowed) {
    if (!observed.has(key)) {
      process.stdout.write(
        `STALE allowance (${count}): ${JSON.parse(key).join(" TS")}; remove the resolved diagnostic\n`,
      )
      failed = true
    }
  }
  process.stdout.write(
    `ACKNOWLEDGED ${acknowledged} existing diagnostic(s); ${diagnostics.length} total; full project ${project}\n`,
  )
  process.exitCode = failed ? 1 : 0
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
