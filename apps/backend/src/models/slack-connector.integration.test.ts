import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseEnv } from "../config/env.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { seedSourcesOrg } from "../test/workspace-sources-fixture.js"
import {
  SlackTeamAlreadyConnectedError,
  upsertSlackConnectionFromOAuth,
} from "./slack-connector.js"

let owner: Awaited<ReturnType<typeof seedSourcesOrg>>
let otherOrgId: string
let teamId: string

/** The OAuth callback upserts in the org transaction of the OAuth state. */
const connect = (orgId: string) =>
  withOrgDbContext(orgId, () =>
    upsertSlackConnectionFromOAuth({
      orgId,
      env: parseEnv(process.env),
      ownerUserId: "fixture-owner",
      botToken: "xoxb-fixture",
      teamId,
    }),
  )

describe("Slack OAuth upsert in the org transaction (Postgres)", () => {
  beforeAll(async () => {
    owner = await seedSourcesOrg("slack_owner")
    // The fixture closes the database on cleanup, so it seeds one org only.
    otherOrgId = `org_test_slack_other_${owner.suffix}`
    await getSystemDb().insert(organizations).values({
      id: otherOrgId,
      slug: otherOrgId,
      name: "slack_other",
      createdAt: new Date(),
    })
    teamId = `T${owner.suffix}`
  })

  afterAll(async () => {
    await getSystemDb().execute(
      sql`delete from connection_directory where org_id in (${owner.orgId}, ${otherOrgId})`,
    )
    await getSystemDb()
      .delete(organizations)
      .where(eq(organizations.id, otherOrgId))
    await owner.cleanup()
  })

  it("reconnects the same team in the same organization", async () => {
    const first = await connect(owner.orgId)
    expect((await connect(owner.orgId)).id).toBe(first.id)
  })

  it("rejects a team that another organization has connected", async () => {
    await expect(connect(otherOrgId)).rejects.toBeInstanceOf(
      SlackTeamAlreadyConnectedError,
    )
  })
})
