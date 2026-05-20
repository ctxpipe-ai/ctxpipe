import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const bin = join(pkgRoot, "bin", "ctxpipe.js")

function help(args: string[]): string {
  return execFileSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    cwd: pkgRoot,
  })
}

describe("CLI help and argv", () => {
  it("init --help documents --base-url and --no-mcp", () => {
    const out = help(["init", "--help"])
    expect(out).toContain("--base-url")
    expect(out).toContain("--no-mcp")
    expect(out).toContain("--agents")
  })

  it("mcp add --help documents --base-url and --scope", () => {
    const out = help(["mcp", "add", "--help"])
    expect(out).toContain("--base-url")
    expect(out).toContain("--scope")
    expect(out).toContain("--org")
  })

  it("auth login --help documents --base-url", () => {
    const out = help(["auth", "login", "--help"])
    expect(out).toContain("--base-url")
  })
})
