import pg from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"

import { checkKnowledgeSearchPlan } from "./knowledge-search-plan.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import { APP_ROLE_NAME } from "./provision-app-role.js"

let pool: pg.Pool

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  pool = new pg.Pool({
    connectionString: ownerUrlForMigrate(process.env.DATABASE_URL),
  })
})

afterAll(async () => {
  await pool.end()
})

it("finds that the GIN index serves the org, the Workspace and the full-text match as the app role", async () => {
  const plan = await checkKnowledgeSearchPlan(pool, APP_ROLE_NAME)
  expect(plan?.served).toBe(true)
})

it("gives no plan, and does not throw, when the check cannot run", async () => {
  expect(
    await checkKnowledgeSearchPlan(pool, "ctxpipe_no_such_role"),
  ).toBeUndefined()
})
