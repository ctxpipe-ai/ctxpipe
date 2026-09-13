import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  classifySandboxCommand,
  parseSandboxLifecycleMarks,
  wrapSandboxSetupCommand,
} from "./sandbox-lifecycle-timing.js"

describe("sandbox lifecycle timing", () => {
  it("names the bootstrap and resume commands we actually run", () => {
    expect(classifySandboxCommand("git cat-file -e 'abc^{commit}'")).toBe(
      "git-cat-file",
    )
    expect(classifySandboxCommand("git checkout --detach 'abc'")).toBe(
      "git-checkout-detach",
    )
    expect(classifySandboxCommand("git rev-parse HEAD")).toBe(
      "git-rev-parse-head",
    )
    expect(
      classifySandboxCommand(
        "command -v opencode >/dev/null 2>&1 || npm install -g opencode-ai",
      ),
    ).toBe("setup-opencode")
    expect(
      classifySandboxCommand("opencode serve --hostname=127.0.0.1 --port=4096"),
    ).toBe("opencode-serve")
  })

  it("wraps a setup command so the bootstrap shell sees the real exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-lifecycle-"))
    const mark = join(dir, "marks.jsonl")
    const wrapped = wrapSandboxSetupCommand(
      "setup-opencode",
      "printf ready; (exit 3)",
    ).replace("/tmp/ctxpipe-sandbox-lifecycle.jsonl", mark)
    const out = execFileSync(
      "sh",
      ["-c", `{ ${wrapped} ; } 2>&1; printf "\\n__BSSH_0__ $?\\n"`],
      { encoding: "utf8" },
    )
    expect(out).toMatch(/__BSSH_0__ 3/)
    const marks = parseSandboxLifecycleMarks(readFileSync(mark, "utf8"))
    expect(marks).toEqual([
      expect.objectContaining({ phase: "setup-opencode" }),
    ])
    expect(marks[0]?.ms).toBeGreaterThanOrEqual(0)
  })
})
