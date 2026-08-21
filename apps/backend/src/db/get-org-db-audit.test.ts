import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = fileURLToPath(new URL("..", import.meta.url))

/** Production modules allowed to call getOrgDb() without wrapping themselves. */
const ALLOWLIST = new Set([
  "db/client.ts",
  "db/org-sql.ts",
  "scripts/reprojectClaimsToGraph.ts",
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      out.push(full)
  }
  return out
}

describe("getOrgDb ambient-context audit", () => {
  it("every production getOrgDb() site is wrapped or allowlisted", () => {
    const files = walk(SRC)
    const violations: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file)
      const text = readFileSync(file, "utf8")
      if (!text.includes("getOrgDb()")) continue
      if (ALLOWLIST.has(rel)) continue
      const wrapped =
        text.includes("withAmbientOrgDb") ||
        text.includes("withOrgDbContext") ||
        text.includes("function orgSql") ||
        text.includes("withSandboxInstanceDb")
      if (!wrapped) violations.push(rel)
    }
    expect(violations).toEqual([])
  })

  it("persistWriteStatus and sandbox instance lookups include orgId predicates", () => {
    const workspaces = readFileSync(join(SRC, "models/workspaces.ts"), "utf8")
    expect(workspaces).toContain("eq(workspaces.orgId, orgId)")
    expect(workspaces).toMatch(
      /persistWriteStatus[\s\S]*eq\(workspaces\.orgId, orgId\)/,
    )
    expect(workspaces).toMatch(
      /async function heartbeatSandboxInstance[\s\S]*?eq\(workspaceSandboxInstances\.orgId, scopedOrgId\)/,
    )
    expect(workspaces).toMatch(
      /async function getSandboxInstance[\s\S]*?eq\(workspaceSandboxInstances\.orgId, scopedOrgId\)/,
    )
    expect(workspaces).toMatch(
      /async function deleteSandboxInstance[\s\S]*?eq\(workspaceSandboxInstances\.orgId, scopedOrgId\)/,
    )
  })
})
