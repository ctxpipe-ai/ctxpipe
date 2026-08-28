import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const pluginRoot = join(repoRoot, "plugins/ctxpipe")

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

describe("Claude plugin manifest", () => {
  it("declares a remote HTTP MCP without orgSlug or userConfig interpolation", () => {
    const plugin = readJson(join(pluginRoot, ".claude-plugin/plugin.json"))
    const mcp = readJson(join(pluginRoot, ".mcp.json"))
    const marketplace = readJson(
      join(repoRoot, ".claude-plugin/marketplace.json"),
    )

    expect(plugin.name).toBe("ctxpipe")
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/)

    const servers = mcp.mcpServers as Record<string, { type?: string; url?: string }>
    expect(servers.ctxpipe).toEqual({
      type: "http",
      url: "https://app.ctxpipe.ai/mcp",
    })
    expect(JSON.stringify(mcp)).not.toContain("${")

    const plugins = marketplace.plugins as Array<{ name: string; source: string }>
    expect(marketplace.name).toBe("ctxpipe")
    expect(plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ctxpipe",
          source: "./plugins/ctxpipe",
        }),
      ]),
    )
  })

  it("ships a ctx-advisor skill that names the MCP tool", () => {
    const skill = readFileSync(
      join(pluginRoot, "skills/ctx-advisor/SKILL.md"),
      "utf8",
    )
    expect(skill).toContain("name: ctx-advisor")
    expect(skill).toContain("ctx_advisor")
  })
})
