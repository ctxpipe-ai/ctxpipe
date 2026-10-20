import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../config/env.js"
import { closeDb, initDb, withOrgDbContext } from "../db/client.js"
import { workspaceSandboxGitTokens } from "../db/schema/workspaces.js"
import { sandboxGitTokenStore } from "./sandbox-git-tokens.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const connectionString = process.env.DATABASE_URL
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_sandbox_tokens_${suffix}`
const otherOrgId = `org_test_sandbox_tokens_other_${suffix}`
const sandboxId = `sandbox-${suffix}`

describe("sandbox GitHub tokens (Postgres)", () => {
  beforeAll(() => {
    if (!connectionString) throw new Error("DATABASE_URL is required")
    initDb(connectionString)
  })

  afterAll(async () => {
    await sandboxGitTokenStore(orgId, parseEnv(process.env)).take(sandboxId)
    await closeDb()
  })

  it("keeps one encrypted token per sandbox, scoped to its org, and hands it back once", async () => {
    const env = parseEnv(process.env)
    const tokens = sandboxGitTokenStore(orgId, env)
    await tokens.put(sandboxId, "ghs_first")
    await tokens.put(sandboxId, "ghs_second")
    expect(await tokens.get(sandboxId)).toMatchObject({ token: "ghs_second" })

    const [stored] = await withOrgDbContext(orgId, (db) =>
      db
        .select()
        .from(workspaceSandboxGitTokens)
        .where(eq(workspaceSandboxGitTokens.sandboxId, sandboxId)),
    )
    expect(stored?.tokenCiphertext).not.toContain("ghs_second")

    const other = sandboxGitTokenStore(otherOrgId, env)
    expect(await other.get(sandboxId)).toBeNull()
    expect(await other.take(sandboxId)).toBeNull()

    expect(await tokens.take(sandboxId)).toBe("ghs_second")
    expect(await tokens.take(sandboxId)).toBeNull()
    expect(await tokens.get(sandboxId)).toBeNull()
  })
})
