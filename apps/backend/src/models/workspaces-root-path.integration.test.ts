import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"

import { withUserIdContext } from "../auth/context.js"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { orgMemberPreferences, workspaces } from "../db/schema/workspaces.js"
import { generateObjectId } from "../lib/id.js"
import {
  createWorkspace,
  getWorkspaceProjection,
  updateWorkspace,
} from "./workspaces.js"

const org = {
  id: generateObjectId("org"),
  slug: generateObjectId("slug"),
  name: "Root folder proof",
}
const user = generateObjectId("user")
const write = { writeStatus: "writable" as const, readOnlyReason: null }

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required")
  initDb(process.env.DATABASE_URL)
  await getSystemDb()
    .insert(organizations)
    .values({ ...org, createdAt: new Date() })
})

afterAll(async () => {
  await withOrgDbContext(org.id, async (db) => {
    await db
      .delete(orgMemberPreferences)
      .where(eq(orgMemberPreferences.orgId, org.id))
    await db.delete(workspaces).where(eq(workspaces.orgId, org.id))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, org.id))
  await closeDb()
})

function inOrg<T>(operation: () => Promise<T>): Promise<T> {
  return withOrgIdContext(org, () => withUserIdContext(user, operation))
}

it("stores the repository root when the create request has no root folder", async () => {
  const created = await inOrg(() =>
    createWorkspace({
      gitUrl: `https://github.com/example-org/plain-${org.id}`,
      write,
    }),
  )
  expect(created.rootPath).toBe("")
})

it("stores the root folder of a new Workspace", async () => {
  const created = await inOrg(() =>
    createWorkspace({
      gitUrl: `https://github.com/example-org/mono-${org.id}`,
      rootPath: "docs/context",
      write,
    }),
  )
  expect(created.rootPath).toBe("docs/context")
})

it("starts a new desired generation when the root folder changes, and puts it in the desired revision", async () => {
  const created = await inOrg(() =>
    createWorkspace({
      gitUrl: `https://github.com/example-org/moved-${org.id}`,
      write,
    }),
  )
  await withOrgDbContext(org.id, (db) =>
    db
      .update(workspaces)
      .set({ desiredSha: "a".repeat(40), desiredDefaultBranch: "main" })
      .where(eq(workspaces.id, created.id)),
  )
  const unchanged = await inOrg(() =>
    updateWorkspace(created.slug, { rootPath: "" }),
  )
  expect(unchanged?.desiredGeneration).toBe(created.desiredGeneration)

  const moved = await inOrg(() =>
    updateWorkspace(created.slug, { rootPath: "docs/context" }),
  )
  expect(moved).toMatchObject({
    rootPath: "docs/context",
    desiredGeneration: created.desiredGeneration + 1,
    desiredSha: null,
    hydrateStatus: "pending",
  })

  await withOrgDbContext(org.id, (db) =>
    db
      .update(workspaces)
      .set({ desiredSha: "b".repeat(40), desiredDefaultBranch: "main" })
      .where(eq(workspaces.id, created.id)),
  )
  const projection = await inOrg(() => getWorkspaceProjection(created.id))
  expect(projection).toMatchObject({
    kind: "building",
    desired: { rootPath: "docs/context", sha: "b".repeat(40) },
  })
})

it("refuses an unsafe root folder", async () => {
  await expect(
    inOrg(() =>
      createWorkspace({
        gitUrl: `https://github.com/example-org/unsafe-${org.id}`,
        rootPath: "../src",
        write,
      }),
    ),
  ).rejects.toThrow()
})
