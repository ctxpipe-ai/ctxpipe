import { readFileSync, realpathSync } from "node:fs"
import { relative } from "node:path"

try {
  const [reportPath, baselinePath, exitCode, expectedFilesPath] =
    process.argv.slice(2)
  const report = JSON.parse(readFileSync(reportPath, "utf8"))
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"))
  if (baseline.version !== 1 || !Array.isArray(baseline.failures))
    throw new Error("Invalid failure baseline")
  const key = ({ file, title, message }) =>
    JSON.stringify([file, title, message])
  const allowed = new Set(baseline.failures.map(key))
  if (allowed.size !== baseline.failures.length)
    throw new Error("Duplicate failure allowance")
  if (!Array.isArray(report.testResults) || report.numTotalTests < 1)
    throw new Error("No tests executed")
  if (report.numPendingTests || report.numTodoTests)
    throw new Error("Skipped or todo tests cannot satisfy CI")
  let passed = 0
  let failed = 0
  const observedFiles = []
  const seen = new Set()
  for (const suite of report.testResults) {
    const file = relative(
      realpathSync(process.cwd()),
      realpathSync(suite.name),
    ).replaceAll("\\", "/")
    observedFiles.push(file)
    if (suite.message || !suite.assertionResults?.length)
      throw new Error(
        `Suite did not execute cleanly: ${file} ${suite.message ?? ""}`,
      )
    for (const assertion of suite.assertionResults) {
      if (assertion.status === "passed") {
        passed += 1
        continue
      }
      if (assertion.status !== "failed")
        throw new Error(`Test did not execute: ${file} ${assertion.fullName}`)
      failed += 1
      // Keep the actual error text, excluding environment-dependent stack frames.
      const message = assertion.failureMessages
        ?.map((text) => text.split(/\n\s+at /)[0])
        .join("\n")
      const failure = { file, title: assertion.fullName, message }
      if (!message || !allowed.has(key(failure)))
        throw new Error(
          `Unexpected failure: ${file} ${assertion.fullName}\n${message}`,
        )
      if (seen.has(key(failure)))
        throw new Error(`Duplicate failing test: ${file} ${assertion.fullName}`)
      seen.add(key(failure))
      process.stdout.write(
        `ACKNOWLEDGED existing failure: ${file} ${assertion.fullName}\n${message}\n`,
      )
    }
  }
  if (
    passed + failed !== report.numTotalTests ||
    passed !== report.numPassedTests ||
    failed !== report.numFailedTests
  )
    throw new Error("Test totals do not match executed cases")
  if (Number(exitCode) !== (failed ? 1 : 0))
    throw new Error(
      `Runner exited ${exitCode}; test results cannot conceal process/setup failures`,
    )
  if (expectedFilesPath) {
    const expected = JSON.parse(readFileSync(expectedFilesPath, "utf8"))
    if (
      JSON.stringify([...expected].sort()) !==
      JSON.stringify(observedFiles.sort())
    )
      throw new Error("Executed test files differ from the required inventory")
  }
  for (const failure of baseline.failures) {
    if (!seen.has(key(failure)))
      throw new Error(
        `Remove resolved allowance: ${failure.file} ${failure.title}`,
      )
  }
  process.stdout.write(
    `EXECUTED ${passed + failed} tests in ${observedFiles.length} files: ${passed} passed, ${failed} acknowledged failures, zero skipped\n`,
  )
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
