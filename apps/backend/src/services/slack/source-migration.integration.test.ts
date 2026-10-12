import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { slackSourceMigrationHook } from "./source-migration.js"

describe("Slack source migration hook (Postgres)", () => {
  let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
  let bound: string

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    seed = await seedSourcesOrg("slack_mig")
    // The config that the Slack setup wrote before ADR-050: auth plus the
    // capture repository binding, and no channel list. Values are made up.
    bound = await seed.addConnection("slack", {
      teamId: `T0${seed.suffix}`.toUpperCase().slice(0, 20),
      teamName: "Example",
      botUserId: "U0BOT0001",
      botHandle: "ctxpipe",
      status: "installed",
      repositoryId: `repo_ctx_${seed.suffix}`,
      branch: "main",
      enabled: true,
    })
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("maps no channels, names why, and keeps the mention capture on", async () => {
    expect(
      await slackSourceMigrationHook.listLegacyBindings({
        orgId: seed.orgId,
        env: parseEnv(process.env),
      }),
    ).toEqual([
      {
        provider: "slack",
        connectionId: bound,
        unmapped: expect.stringContaining("no channel scope"),
      },
    ])
    expect(slackSourceMigrationHook.disableLegacy).toBeUndefined()
  })
})
