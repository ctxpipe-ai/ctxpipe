import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { isLegacyBindingHandedOver } from "../../domain/workspace-sources/legacy-handover.js"
import { planSourceMigration } from "../../domain/workspace-sources/migration-plan.js"
import {
  parseSourceEntry,
  sourcesFileSchema,
} from "../../domain/workspace-sources/sources-file.js"
import { applySourcesYamlChange } from "../../domain/workspace-sources/sources-yaml-edit.js"
import { parseSourcesYaml } from "../../domain/workspace-sources/sources-yaml.js"
import { encryptConnectionSecret } from "../../lib/connection-secrets.js"
import { getPagerdutyConnectionByConnectionId } from "../../models/pagerduty-connector.js"
import { replaceWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import { parsePagerdutyConfigYamlContent } from "./config-yaml.js"
import { createPagerdutySourceMigrationHook } from "./workspace-source-migration.js"

/** A `pagerduty/config.yaml` as the old PagerDuty settings wrote it. */
const LEGACY_CONFIG = `version: 1
source: pagerduty
account:
  id: PACCT01
  name: Acme Test
  subdomain: acme-test
  region: us
scope:
  services:
    - id: PSVC001
      name: checkout-api
      url: https://acme-test.pagerduty.com/service-directory/PSVC001
    - id: PSVC002
      name: billing-worker
`

let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
let env: ReturnType<typeof parseEnv>

const account = () => ({
  accessTokenEnc: encryptConnectionSecret("fixture-token", env),
  accountId: "PACCT01",
  accountName: "Acme Test",
  accountSubdomain: "acme-test",
  region: "us",
  ownerUserId: "user_fixture",
  status: "installed",
})

describe("PagerDuty source migration hook (Postgres)", () => {
  beforeAll(async () => {
    seed = await seedSourcesOrg("wsrc_pagerduty_migrate")
    env = parseEnv(process.env)
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  async function addRepository(name: string) {
    const github = await seed.addConnection("github", {})
    const repositoryId = `repo_${name}_${seed.suffix}`
    const gitUrl = `https://github.com/acme/${name}-${seed.suffix}.git`
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: `acme/${name}`,
        gitUrl,
        githubConnectionId: github,
      }),
    )
    return { repositoryId, gitUrl }
  }

  it("turns the live pagerduty/config.yaml into a source entry", async () => {
    const { repositoryId, gitUrl } = await addRepository("pd-context")
    const binding = {
      ...account(),
      repositoryId,
      branch: "main",
      enabled: true,
    }
    const live = await seed.addConnection("pagerduty", {
      ...binding,
      setupPhase: "live",
    })
    const pending = await seed.addConnection("pagerduty", {
      ...binding,
      setupPhase: "awaiting_merge",
    })
    const off = await seed.addConnection("pagerduty", {
      ...binding,
      enabled: false,
      setupPhase: "live",
    })
    const unbound = await seed.addConnection("pagerduty", account())
    const reads: string[] = []
    const hook = createPagerdutySourceMigrationHook(async (input) => {
      reads.push(`${input.repositoryName}@${input.branch}`)
      return parsePagerdutyConfigYamlContent(LEGACY_CONFIG)
    })

    const bindings = await hook.listLegacyBindings({ orgId: seed.orgId, env })

    const scope = { services: ["PSVC001", "PSVC002"] }
    const byConnection = new Map(
      bindings.map((item) => [item.connectionId, item]),
    )
    expect(byConnection.get(live)).toEqual({
      provider: "pagerduty",
      connectionId: live,
      syncRepositoryUrl: gitUrl,
      scope,
    })
    expect(byConnection.get(pending)).toMatchObject({
      unmapped: expect.stringMatching(/not merged/),
    })
    expect(byConnection.get(off)).toMatchObject({
      unmapped: expect.stringMatching(/turned off/),
    })
    expect(byConnection.get(unbound)).toMatchObject({
      unmapped: expect.stringMatching(/no sync repository/),
    })
    expect(reads).toEqual(["acme/pd-context@main"])

    const { changes } = planSourceMigration({
      workspaces: [
        {
          id: "ws_context",
          workspaceRepositoryUrl: gitUrl,
          githubConnectionId: "con_gh1",
          sourcesFile: null,
        },
      ],
      linked: [],
      bindings: [...byConnection.values()],
    })
    let text: string | null = null
    for (const change of changes.get("ws_context") ?? [])
      text = applySourcesYamlChange(text, change).text
    const file = sourcesFileSchema.parse(parseSourcesYaml(text ?? ""))
    expect(file.sources.map(parseSourceEntry)).toEqual([
      {
        ok: true,
        entry: expect.objectContaining({
          provider: "pagerduty",
          connectionId: live,
          scope,
        }),
      },
    ])
  })

  it("reports an old config without services", async () => {
    const { repositoryId } = await addRepository("pd-empty")
    const connection = await seed.addConnection("pagerduty", {
      ...account(),
      repositoryId,
      branch: "main",
      setupPhase: "live",
    })
    const hook = createPagerdutySourceMigrationHook(async () =>
      parsePagerdutyConfigYamlContent(
        LEGACY_CONFIG.slice(0, LEGACY_CONFIG.indexOf("scope:")),
      ),
    )
    const bindings = await hook.listLegacyBindings({ orgId: seed.orgId, env })
    expect(bindings.find((item) => item.connectionId === connection)).toEqual({
      provider: "pagerduty",
      connectionId: connection,
      unmapped: expect.stringMatching(/at least one PagerDuty service/),
    })
  })

  it("hands a legacy binding over to Workspace sources and turns it off", async () => {
    const { repositoryId, gitUrl } = await addRepository("pd-handover")
    const connection = await seed.addConnection("pagerduty", {
      ...account(),
      repositoryId,
      branch: "main",
      setupPhase: "live",
    })
    const handedOver = () =>
      isLegacyBindingHandedOver("pagerduty", {
        orgId: seed.orgId,
        connectionId: connection,
        repositoryGitUrl: gitUrl,
      })
    expect(await handedOver()).toBe(false)

    const workspaceId = await seed.addWorkspace(
      `pd-handover-${seed.suffix}`.slice(0, 40),
      gitUrl.replace(/\.git$/, ""),
    )
    await replaceWorkspaceSourceRows({
      orgId: seed.orgId,
      workspaceId,
      revision: "a".repeat(40),
      rows: [
        {
          sourceKey: "on-call",
          provider: "pagerduty",
          connectionId: connection,
          scope: { services: ["PSVC001"] },
          status: "ok",
          statusDetail: null,
        },
      ],
    })
    expect(await handedOver()).toBe(true)

    // --apply turns the legacy binding off and keeps the tokens.
    await createPagerdutySourceMigrationHook().disableLegacy?.({
      orgId: seed.orgId,
      connectionId: connection,
    })
    const stored = await getPagerdutyConnectionByConnectionId(
      seed.orgId,
      connection,
      env,
    )
    expect(stored?.enabled).toBe(false)
    expect(stored?.accessToken).toBe("fixture-token")
  })
})
