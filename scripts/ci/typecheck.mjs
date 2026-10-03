import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
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
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  })
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  process.stdout.write(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => dirname(configPath),
      getNewLine: () => "\n",
    }),
  )
  const repository = fileURLToPath(new URL("../../", import.meta.url)).replace(
    /\/$/,
    "",
  )
  const observed = new Map()
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
    const previous = observed.get(identity(item))
    if (previous) previous.count += 1
    else observed.set(identity(item), item)
  }
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
