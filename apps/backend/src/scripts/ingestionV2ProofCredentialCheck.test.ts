import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const script = fileURLToPath(
  new URL(
    "../../../../scripts/ci/ingestion-v2-sandbox-credential-check.sh",
    import.meta.url,
  ),
)

// Built at run time so that no secret scanner sees a token in the repository.
const githubToken = `ghp_${"a1B2".repeat(9)}`
const modelKey = `sk-or-v1-${"c3D4".repeat(8)}`

let dir: string
let home: string
let proc: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cred-check-"))
  home = join(dir, "home")
  proc = join(dir, "proc")
  mkdirSync(home)
  mkdirSync(proc)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(env: Record<string, string> = {}) {
  const result = spawnSync("sh", [script], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      CRED_CHECK_PROC: proc,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      ...env,
    },
    encoding: "utf8",
  })
  return { code: result.status, out: result.stdout + result.stderr }
}

describe("sandbox credential check", () => {
  it("passes a clean sandbox and counts the proxy session without flagging it", () => {
    const result = run({
      HTTPS_PROXY: "http://session:abc123@172.30.99.11:14322",
    })
    expect(result.code).toBe(0)
    expect(result.out).toContain("findings=0")
    expect(result.out).toContain("proxySessionVars=1")
  })

  it("fails on a GitHub token in the environment and never prints the value", () => {
    const result = run({ SOME_SETTING: githubToken })
    expect(result.code).toBe(1)
    expect(result.out).toContain("FINDING env SOME_SETTING github-token")
    expect(result.out).not.toContain(githubToken)
  })

  it("fails on a GitHub App installation token in the current form (CTX-845)", () => {
    const appToken = `ghs_${"1234567"}_${"Ab3dE_f6Gh-9jKmN2pQ"}.${"rS5tU-v8Wx_y1Z"}`
    const result = run({ SOME_SETTING: appToken })
    expect(result.code).toBe(1)
    expect(result.out).toContain("FINDING env SOME_SETTING github-token")
    expect(result.out).not.toContain(appToken)
  })

  it("fails on a model key by pattern and by known hash", () => {
    const known = "plain-model-key-without-a-known-prefix"
    const hash = createHash("sha256").update(known).digest("hex")
    const byPattern = run({ KEY_A: modelKey })
    expect(byPattern.out).toContain("FINDING env KEY_A model-or-private-key")
    const byHash = run({ KEY_B: known, FORBIDDEN_SHA256: `x ${hash}` })
    expect(byHash.code).toBe(1)
    expect(byHash.out).toContain("FINDING env KEY_B known-secret-value")
    expect(byHash.out).not.toContain(known)
  })

  it("fails on a vault token variable name", () => {
    const result = run({ AGENT_VAULT_OWNER_PASSWORD: "x" })
    expect(result.code).toBe(1)
    expect(result.out).toContain(
      "AGENT_VAULT_OWNER_PASSWORD secret-variable-name",
    )
  })

  it("fails on a token in another process environment", () => {
    mkdirSync(join(proc, "42"))
    writeFileSync(
      join(proc, "42", "environ"),
      `PATH=/bin\0TOKEN_X=${githubToken}\0`,
    )
    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain("FINDING proc:42 TOKEN_X github-token")
    expect(result.out).toContain("processes=1")
    expect(result.out).not.toContain(githubToken)
  })

  it("fails on .netrc, a token in git config, and a credential helper", () => {
    writeFileSync(join(home, ".netrc"), "machine github.com password x\n")
    writeFileSync(
      join(home, ".gitconfig"),
      `[credential]\n\thelper = store\n[url "https://x:${githubToken}@github.com/"]\n\tinsteadOf = https://github.com/\n`,
    )
    const result = run()
    expect(result.code).toBe(1)
    expect(result.out).toContain("credential-file")
    expect(result.out).toContain("token-in-file")
    expect(result.out).toContain("credential-helper")
    expect(result.out).not.toContain(githubToken)
  })

  it("is a valid shell script", () => {
    expect(() => execFileSync("sh", ["-n", script])).not.toThrow()
  })
})
