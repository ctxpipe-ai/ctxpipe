import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import { z } from "zod"
import { recordSpans } from "../../test/spans.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { generateObjectId } from "../lib/id.js"
import { readAttribution } from "../observability/attribution.js"
import { defineWorkflow } from "./defineObservedWorkflow.js"

recordSpans()

const orgId = generateObjectId("org")
const orgSlug = `job-slug-${orgId.slice(-8)}`

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  await getSystemDb().insert(organizations).values({
    id: orgId,
    name: "Job slug org",
    slug: orgSlug,
    createdAt: new Date(),
  })
})

afterAll(async () => {
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

it("adds the org slug to a job that has only the org id, so Langfuse gets the org tag", async () => {
  const workflow = defineWorkflow(
    { name: "slug-lookup", schema: z.object({ orgId: z.string() }) },
    async ({ input }) => ({ input, attribution: readAttribution() }),
  )
  const result = await workflow.fn({
    input: { orgId },
    step: {} as never,
    version: null,
    run: {} as never,
  })
  expect(result.attribution).toMatchObject({
    "ctxpipe.org.id": orgId,
    "ctxpipe.org.slug": orgSlug,
  })
  expect(result.input).toEqual({ orgId })
})
