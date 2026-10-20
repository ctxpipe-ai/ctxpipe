// Proves the release download fails fast when the source stalls.
// Run: node --test apps/codesearch/scripts/fetch-releases.test.mjs
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./fetch-releases.sh", import.meta.url))
let server
let base
before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") return res.end("hello")
    // Send headers, then never finish the body.
    res.writeHead(200, { "content-length": "100" })
    res.write("x")
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.closeAllConnections()
  server.close()
})

function run(manifestText, extraArgs = [], env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fetch-"))
  const manifest = join(dir, "m.txt")
  writeFileSync(manifest, manifestText)
  return new Promise((resolve) => {
    const child = spawn(
      "bash",
      [script, manifest, join(dir, "out"), ...extraArgs.map((a) => a(dir))],
      {
        env: {
          ...process.env,
          FETCH_STALL_TIMEOUT: "1",
          FETCH_MAX_TIME: "3",
          FETCH_RETRY_DELAY: "0",
          ...env,
        },
      },
    )
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => resolve({ code, stderr, dir }))
  })
}

// 3 attempts x at most 3 s each, plus slack. Without the download timeouts the
// script never ends, and the node:test timeout fails the test.
test(
  "a stalled source fails within the timeouts with the outside-service message",
  { timeout: 15000 },
  async () => {
    const sha = createHash("sha256").update("hello").digest("hex")
    const r = await run(`a\t${sha}\t${base}/stall\n`)
    assert.notEqual(r.code, 0)
    assert.match(r.stderr, /Outside service unavailable/)
  },
)

test("a file with the right checksum downloads and fills the cache; a bad checksum fails", async () => {
  const sha = createHash("sha256").update("hello").digest("hex")
  const good = await run(`a\t${sha}\t${base}/ok\n`, [(d) => join(d, "cache")])
  assert.equal(good.code, 0, good.stderr)
  assert.equal(readFileSync(join(good.dir, "cache", "a"), "utf8"), "hello")
  const bad = await run(`a\t${"0".repeat(64)}\t${base}/ok\n`)
  assert.notEqual(bad.code, 0)
  assert.match(bad.stderr, /Checksum mismatch/)
  assert.ok(!existsSync(join(bad.dir, "cache")))
})

test("a cached file is used without any download", async () => {
  const sha = createHash("sha256").update("hello").digest("hex")
  const r = await run(`a\t${sha}\thttp://127.0.0.1:1/never\n`, [
    (d) => {
      const c = join(d, "cache")
      mkdirSync(c, { recursive: true })
      writeFileSync(join(c, "a"), "hello")
      return c
    },
  ])
  assert.equal(r.code, 0, r.stderr)
})
