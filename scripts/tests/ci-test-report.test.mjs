import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

test("a known failing test must execute, and cannot cover a different failure or skipped proof", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-test-report-"))
  try {
    const known = {
      file: "src/chat.test.ts",
      title: "chat streams",
      message: "AssertionError: missing terminal",
    }
    mkdirSync(join(directory, "src"))
    writeFileSync(join(directory, known.file), "// Report input fixture\n")
    writeFileSync(
      join(directory, "baseline.json"),
      JSON.stringify({ version: 1, failures: [known] }),
    )
    const check = (status, message = known.message) => {
      writeFileSync(
        join(directory, "report.json"),
        JSON.stringify({
          numTotalTests: 1,
          numPassedTests: status === "passed" ? 1 : 0,
          numFailedTests: status === "failed" ? 1 : 0,
          numPendingTests: status === "pending" ? 1 : 0,
          numTodoTests: 0,
          testResults: [
            {
              name: join(directory, known.file),
              status: status === "failed" ? "failed" : "passed",
              message: "",
              assertionResults: [
                {
                  fullName: known.title,
                  status,
                  failureMessages:
                    status === "failed"
                      ? [message + "\n    at fixture.ts:1:1"]
                      : [],
                },
              ],
            },
          ],
        }),
      )
      return spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../ci/check-test-report.mjs", import.meta.url),
          ),
          "report.json",
          "baseline.json",
          status === "failed" ? "1" : "0",
        ],
        { cwd: directory, encoding: "utf8" },
      )
    }
    const executed = check("failed")
    assert.equal(executed.status, 0, executed.stdout + executed.stderr)
    assert.match(executed.stdout, /ACKNOWLEDGED.*chat streams/)
    assert.equal(check("failed", "Error: database unavailable").status, 1)
    assert.equal(check("pending").status, 1)
    const fixed = check("passed")
    assert.equal(fixed.status, 1)
    assert.match(fixed.stderr, /Remove resolved allowance/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
