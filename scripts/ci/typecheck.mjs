import {
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

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
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    )
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    { noEmit: true },
    configPath,
  )
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, "\n"),
        )
        .join("\n"),
    )
  }
  const repository = fileURLToPath(new URL("../../", import.meta.url)).replace(
    /\/$/,
    "",
  )
  // An incremental program checks again only the files that a change can
  // affect, and reads the diagnostics of the other files from the build info
  // of the last run. CI keeps the build info in its cache (the Typecheck
  // job). TypeScript can write a union or a property list in a different
  // order when it checks only some files, and the allowance compares the
  // message text. Thus, when the result does not match the allowance, the
  // check starts again without the build info. A run without the build info
  // checks all files in the order of a full program, so a failure always
  // comes from a full check.
  const buildInfo = join(
    repository,
    "node_modules/.cache/typecheck",
    `${relative(repository, configPath).replaceAll(/[\\/]/g, "_")}.tsbuildinfo`,
  )
  const check = () => {
    const program = ts.createIncrementalProgram({
      rootNames: parsed.fileNames,
      options: {
        ...parsed.options,
        incremental: true,
        tsBuildInfoFile: buildInfo,
      },
      projectReferences: parsed.projectReferences,
    })
    // getPreEmitDiagnostics accepts a builder program: it calls the same
    // diagnostic methods, and the builder answers from the build info.
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      )
    program.emitBuildInfo()
    const observed = new Map()
    const keys = new Map()
    for (const diagnostic of diagnostics) {
      const item = {
        file: diagnostic.file
          ? relative(dirname(configPath), diagnostic.file.fileName).replaceAll(
              "\\",
              "/",
            )
          : "<compiler>",
        code: diagnostic.code,
        message: ts
          .flattenDiagnosticMessageText(diagnostic.messageText, "\n")
          .replaceAll(repository, "<repo>")
          .replaceAll(realpathSync(repository), "<repo>"),
        count: 1,
      }
      keys.set(diagnostic, identity(item))
      const previous = observed.get(identity(item))
      if (previous) previous.count += 1
      else observed.set(identity(item), item)
    }
    return { diagnostics, observed, keys }
  }
  const matches = ({ observed }) =>
    observed.size === allowed.size &&
    [...observed].every(([key, item]) => allowed.get(key) === item.count)
  let mode = "full"
  let result
  if (existsSync(buildInfo)) {
    result = check()
    mode = "incremental"
    if (!matches(result)) {
      rmSync(buildInfo)
      mode = "full after an incremental mismatch"
    }
  }
  if (mode !== "incremental") result = check()
  const { diagnostics, observed, keys } = result
  if (reportPath) {
    writeFileSync(
      reportPath,
      JSON.stringify(
        { version: 1, diagnostics: [...observed.values()] },
        null,
        2,
      ) + "\n",
    )
  }
  // Print only the diagnostics that do not match the allowance. The CI
  // problem matcher makes each printed diagnostic an error annotation, so
  // acknowledged diagnostics in the output hide the true cause of a failure.
  process.stdout.write(
    ts.formatDiagnostics(
      diagnostics.filter(
        (diagnostic) =>
          allowed.get(keys.get(diagnostic)) !==
          observed.get(keys.get(diagnostic)).count,
      ),
      {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => dirname(configPath),
        getNewLine: () => "\n",
      },
    ),
  )
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
    `ACKNOWLEDGED ${acknowledged} existing diagnostic(s); ${diagnostics.length} total; full project ${project} (${mode})\n`,
  )
  process.exitCode = failed ? 1 : 0
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
