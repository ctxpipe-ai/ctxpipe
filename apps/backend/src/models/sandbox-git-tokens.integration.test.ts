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
const key = `run:conv_${suffix}:clone:1`

describe("sandbox GitHub tokens (Postgres)", () => {
  beforeAll(() => {
    if (!connectionString) throw new Error("DATABASE_URL is required")
    initDb(connectionString)
  })

  afterAll(async () => {
    await sandboxGitTokenStore(orgId, parseEnv(process.env)).take(key)
    await closeDb()
  })

  it("keeps one encrypted token per key, scoped to its org, and hands it back once", async () => {
    const env = parseEnv(process.env)
    const tokens = sandboxGitTokenStore(orgId, env)
    expect(await tokens.add(key, "ghs_first")).toBe(true)
    // A key that holds a token keeps it.
    expect(await tokens.add(key, "ghs_second")).toBe(false)
    expect(await tokens.get(key)).toMatchObject({ token: "ghs_first" })
    expect(
      (await tokens.list(`run:conv_${suffix}:`)).map((row) => [
        row.key,
        row.token,
      ]),
    ).toEqual([[key, "ghs_first"]])

    const [stored] = await withOrgDbContext(orgId, (db) =>
      db
        .select()
        .from(workspaceSandboxGitTokens)
        .where(eq(workspaceSandboxGitTokens.sandboxId, key)),
    )
    expect(stored?.tokenCiphertext).not.toContain("ghs_first")

    const other = sandboxGitTokenStore(otherOrgId, env)
    expect(await other.get(key)).toBeNull()
    expect(await other.list(`run:conv_${suffix}:`)).toEqual([])
    expect(await other.take(key)).toBeNull()

    expect(await tokens.take(key)).toBe("ghs_first")
    expect(await tokens.take(key)).toBeNull()
    expect(await tokens.get(key)).toBeNull()
  })
})
