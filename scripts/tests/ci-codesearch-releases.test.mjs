import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const script = fileURLToPath(
  new URL("../../apps/codesearch/scripts/fetch-releases.sh", import.meta.url),
)
for (const arch of ["amd64", "arm64"]) {
  test(`${arch} downloads and caches only matching and shared release files`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "codesearch-releases-"))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, "asset"), "hello")
    const sha = createHash("sha256").update("hello").digest("hex")
    const names = [
      "scip-go-amd64.tar.gz",
      "scip-go-arm64.tar.gz",
      "scip-java",
      "scip-clang-amd64",
      "scip-ruby-amd64",
    ]
    const expected =
      arch === "arm64"
        ? ["scip-go-arm64.tar.gz", "scip-java"]
        : [
            "scip-clang-amd64",
            "scip-go-amd64.tar.gz",
            "scip-java",
            "scip-ruby-amd64",
          ]
    const manifest = names
      .map(
        (name) =>
          `${name}\t${sha}\t${pathToFileURL(join(dir, expected.includes(name) ? "asset" : "missing"))}\n`,
      )
      .join("")
    writeFileSync(join(dir, "manifest"), manifest)
    const result = spawnSync(
      "bash",
      [script, join(dir, "manifest"), join(dir, "out"), join(dir, "cache")],
      {
        encoding: "utf8",
        env: { ...process.env, TARGETARCH: arch, FETCH_RETRY_DELAY: "0" },
        timeout: 10000,
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readdirSync(join(dir, "out")).sort(), expected)
    assert.deepEqual(readdirSync(join(dir, "cache")).sort(), expected)
  })
}
