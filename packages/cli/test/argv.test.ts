import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
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

  it("doctor --help still documents environment diagnostics", () => {
    const out = help(["doctor", "--help"])
    expect(out).toContain("--json")
    expect(out).toContain("mcp")
    expect(out).toContain("environment diagnostics")
  })

  it("doctor --json still prints environment diagnostics", () => {
    const out = execFileSync(process.execPath, [bin, "doctor", "--json"], {
      encoding: "utf8",
      cwd: pkgRoot,
    })
    const data = JSON.parse(out) as { package?: string; node?: string }
    expect(data.package).toBe("ctxpipe")
    expect(data.node).toEqual(expect.stringMatching(/^v\d+/))
  })

  it("doctor mcp --help documents endpoint diagnostics", () => {
    const out = help(["doctor", "mcp", "--help"])
    expect(out).toContain("--url")
    expect(out).toContain("--timeout")
    expect(out).toContain("--json")
    expect(out).toContain("Streamable HTTP")
    expect(out).toContain("does not run browser OAuth")
  })

  it("memory --help lists the memory subcommands", () => {
    const out = help(["memory", "--help"])
    expect(out).toContain("init")
    expect(out).toContain("capture")
    expect(out).toContain("status")
    expect(out).toContain("doctor")
    expect(out).toContain("stop")
  })

  it("memory init --help documents --agents and --non-interactive", () => {
    const out = help(["memory", "init", "--help"])
    expect(out).toContain("--agents")
    expect(out).toContain("--non-interactive")
    expect(out).toContain("--org")
  })

  it("memory capture --help documents observe and summary", () => {
    const out = help(["memory", "capture", "--help"])
    expect(out).toContain("observe")
    expect(out).toContain("summary")
    expect(out).toContain("finalize")
    expect(out).toContain("promote")
    expect(out).toContain("dismiss")
  })

  it("memory status --help documents --json", () => {
    const out = help(["memory", "status", "--help"])
    expect(out).toContain("--json")
  })

  it("memory doctor --help documents --json", () => {
    const out = help(["memory", "doctor", "--help"])
    expect(out).toContain("--json")
  })

  it("memory stop --help is available", () => {
    const out = help(["memory", "stop", "--help"])
    expect(out).toContain("stop")
  })

  it("init --help documents --memory / --no-memory", () => {
    const out = help(["init", "--help"])
    expect(out).toContain("--memory")
    expect(out).toContain("--no-memory")
  })

  it("init --help documents --non-interactive (with -y alias)", () => {
    const out = help(["init", "--help"])
    expect(out).toContain("--non-interactive")
    expect(out).toContain("-y")
  })

  it("init and mcp add --help document OAuth vs API-key auth", () => {
    const initHelp = help(["init", "--help"])
    const addHelp = help(["mcp", "add", "--help"])
    for (const out of [initHelp, addHelp]) {
      expect(out).toContain("--auth")
      expect(out).toContain("--api-key")
      expect(out).toContain("--api-key-env-variable")
      expect(out).toContain("oauth")
      expect(out).toContain("api-key")
    }
  })

  it("mcp add --auth api-key without a key fails", () => {
    try {
      execFileSync(
        process.execPath,
        [
          bin,
          "mcp",
          "add",
          "--org",
          "acme",
          "--client",
          "cursor",
          "--scope",
          "user",
          "--auth",
          "api-key",
          "--non-interactive",
          "--dry-run",
          "--json",
        ],
        {
          encoding: "utf8",
          cwd: pkgRoot,
          env: { ...process.env, CTXPIPE_API_KEY: "" },
        },
      )
      throw new Error("expected mcp add to fail")
    } catch (error) {
      const err = error as { status?: number; stderr: string; stdout: string }
      expect(err.status).not.toBe(0)
      expect(`${err.stderr}${err.stdout}`).toContain("Missing API key")
    }
  })

  it("mcp add --scope repo with an API key skips repo MCP writes", () => {
    const out = execFileSync(
      process.execPath,
      [
        bin,
        "mcp",
        "add",
        "--org",
        "acme",
        "--client",
        "cursor",
        "--scope",
        "repo",
        "--auth",
        "api-key",
        "--api-key",
        "ctxp_secret",
        "--non-interactive",
        "--dry-run",
        "--json",
      ],
      {
        encoding: "utf8",
        cwd: pkgRoot,
        env: { ...process.env, CTXPIPE_API_KEY: "" },
      },
    )
    const data = JSON.parse(out) as { status: string; operations: string[] }
    expect(data.status).toBe("dry-run")
    expect(data.operations).toEqual([
      expect.stringContaining("skip repo MCP writes"),
    ])
  })

  it("mcp add --auth api-key writes x-api-key to user Cursor config only", () => {
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mcp-home-"))
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mcp-cwd-"))
    execFileSync(
      process.execPath,
      [
        bin,
        "mcp",
        "add",
        "--org",
        "acme",
        "--client",
        "cursor",
        "--scope",
        "user",
        "--auth",
        "api-key",
        "--api-key",
        "ctxp_secret",
        "--non-interactive",
      ],
      {
        encoding: "utf8",
        cwd,
        env: { ...process.env, HOME: home, CTXPIPE_API_KEY: "" },
      },
    )
    const userConfig = JSON.parse(
      readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
    ) as {
      mcpServers: { ctxpipe?: { headers?: { "x-api-key"?: string } } }
    }
    expect(userConfig.mcpServers.ctxpipe?.headers?.["x-api-key"]).toBe(
      "ctxp_secret",
    )
    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(false)
  })

  it("mcp add --api-key-env-variable writes env references to repo and user Cursor config", () => {
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mcp-env-home-"))
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mcp-env-cwd-"))
    execFileSync(
      process.execPath,
      [
        bin,
        "mcp",
        "add",
        "--org",
        "acme",
        "--client",
        "cursor",
        "--scope",
        "both",
        "--api-key-env-variable",
        "CTXPIPE_API_KEY",
        "--non-interactive",
      ],
      {
        encoding: "utf8",
        cwd,
        env: {
          ...process.env,
          HOME: home,
          CTXPIPE_API_KEY: "ctxp_must_not_be_written",
        },
      },
    )
    const header = { "x-api-key": `\${env:CTXPIPE_API_KEY}` }
    const repoConfig = JSON.parse(
      readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
    ) as {
      mcpServers: { ctxpipe?: { headers?: { "x-api-key"?: string } } }
    }
    const userConfig = JSON.parse(
      readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
    ) as {
      mcpServers: { ctxpipe?: { headers?: { "x-api-key"?: string } } }
    }
    expect(repoConfig.mcpServers.ctxpipe?.headers).toEqual(header)
    expect(userConfig.mcpServers.ctxpipe?.headers).toEqual(header)
  })
})
