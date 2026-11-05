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
  const identity = ({ file, code, message }) =>
    JSON.stringify([file, code, message])
  const allowed = new Map()
  for (const item of baseline.diagnostics) {
    if (
      typeof item.file !== "string" ||
      typeof item.message !== "string" ||
      !Number.isInteger(item.code) ||
      !Number.isInteger(item.count) ||
      item.count < 1 ||
      allowed.has(identity(item))
    ) {
      throw new Error("Invalid or duplicate diagnostic entry")
    }
    allowed.set(identity(item), item.count)
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
      encoding: "utf8",
      maxBuffer: 1 << 28,
    },
  )
  if (run.error) throw run.error
  // A diagnostic starts with `file(line,col): error TSnnnn: text`, or with
  // `error TSnnnn: text` when it has no file (a tsconfig error). The lines
  // that follow it and start with a space are the rest of its message.
  const diagnostics = []
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
    }
  }
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(
      `bun check failed (${run.signal ?? `exit ${run.status}`})\n${run.stdout}${run.stderr}`,
    )
  }
  if ((run.status === 1) !== diagnostics.length > 0) {
    throw new Error(
      `bun check exit ${run.status} does not match ${diagnostics.length} parsed diagnostic(s)\n${run.stdout}${run.stderr}`,
    )
  }
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
        `STALE allowance (${count}): ${key}; remove the resolved diagnostic\n`,
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
