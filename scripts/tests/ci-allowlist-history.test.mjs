import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

test("a diagnostic removed from the committed baseline cannot be added back", () => {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-allowlist-"))
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
  }
  const write = (count) =>
    writeFileSync(
      join(directory, "baseline.json"),
      JSON.stringify({
        version: 1,
        diagnostics: count
          ? [
              {
                file: "src/a.ts",
                code: 2322,
                message: "Known diagnostic",
                count,
              },
            ]
          : [],
      }),
    )
  const check = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../ci/check-allowlist-history.mjs", import.meta.url),
        ),
        "baseline.json",
      ],
      { cwd: directory, encoding: "utf8" },
    )
  try {
    git("init", "-b", "main")
    git("config", "user.email", "fixture@example.test")
    git("config", "user.name", "Fixture")
    write(2)
    git("add", "baseline.json")
    git("commit", "-m", "Initial reviewed baseline")
    write(1)
    assert.equal(check().status, 0)
    git("add", "baseline.json")
    git("commit", "-m", "Remove one resolved diagnostic")
    write(2)
    const restored = check()
    assert.equal(restored.status, 1)
    assert.match(restored.stderr, /may only shrink/)
    // A later shrink must not conceal an expansion already committed in the PR.
    git("add", "baseline.json")
    git("commit", "-m", "Unauthorized expansion")
    write(1)
    assert.equal(check().status, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
