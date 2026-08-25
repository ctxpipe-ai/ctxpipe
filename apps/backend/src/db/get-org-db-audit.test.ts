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
        text.includes("orgSql") ||
        text.includes("withSandboxInstanceDb")
      if (!wrapped) violations.push(rel)
    }
    expect(violations).toEqual([])
  })

  it("getSystemDb does not query tenant tables except the migrate-role allowlist", () => {
    const tenantTables =
      "connections|repositories|objects|claims|claimEvidence|workspaces|workspaceLinkedRepositories|workspaceWriteJobs|workspaceSandboxInstances|workspaceKnowledgeUnits|orgMemberPreferences|conversationMessages|conversations|confluenceSpaces|confluenceSyncTargets|orgOnboarding|repositoryCheckouts"
    const tenantFrom = new RegExp(
      `(?:\\.from\\(\\s*(?:${tenantTables})\\s*\\)|\\.(?:insert|update|delete)\\(\\s*(?:${tenantTables})\\s*\\)|\\.query\\.(?:${tenantTables}))`,
    )
    const allowlist = new Set([
      "db/client.ts",
      "scripts/backfillGithubConnectionSecrets.ts",
    ])
    const files = walk(SRC)
    const violations: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file)
      if (allowlist.has(rel)) continue
      const text = readFileSync(file, "utf8")
      if (!text.includes("getSystemDb")) continue
      const starts: number[] = []
      const startRe = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+\w+/g
      for (;;) {
        const match = startRe.exec(text)
        if (!match) break
        starts.push(match.index)
      }
      if (starts.length === 0) continue
      starts.push(text.length)
      for (let i = 0; i < starts.length - 1; i++) {
        const body = text.slice(starts[i], starts[i + 1])
        if (!body.includes("getSystemDb")) continue
        const fromRe = new RegExp(tenantFrom.source, "g")
        for (;;) {
          const fromMatch = fromRe.exec(body)
          if (!fromMatch) break
          const before = body.slice(0, fromMatch.index)
          const lastSystem = before.lastIndexOf("getSystemDb")
          const lastOrg = Math.max(
            before.lastIndexOf("getOrgDb"),
            before.lastIndexOf("withOrgDbContext"),
          )
          if (lastSystem >= 0 && lastSystem > lastOrg) {
            violations.push(`${rel}:${i + 1}`)
            break
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("persistWriteStatus and sandbox instance lookups include orgId predicates", () => {
    const workspaces = readFileSync(join(SRC, "models/workspaces.ts"), "utf8")
    const sandboxes = readFileSync(
      join(SRC, "models/workspace-sandboxes.ts"),
      "utf8",
    )
    expect(workspaces).toContain("eq(workspaces.orgId, orgId)")
    expect(workspaces).toMatch(
      /persistWriteStatus[\s\S]*eq\(workspaces\.orgId, orgId\)/,
    )
    for (const name of [
      "heartbeatSandboxInstance",
      "getSandboxInstance",
      "deleteSandboxInstance",
    ] as const) {
      const start = sandboxes.indexOf(`export async function ${name}`)
      if (start < 0) throw new Error(`missing ${name}`)
      const next = sandboxes.indexOf("\nexport async function ", start + 1)
      const body =
        next < 0 ? sandboxes.slice(start) : sandboxes.slice(start, next)
      expect(body).toContain("eq(workspaceSandboxInstances.orgId, scopedOrgId)")
    }
  })
})
