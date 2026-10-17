import pg from "pg"
import { afterAll, beforeAll, expect, it } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"
import { reconcileConnectionDirectory } from "./reconcile-connection-directory.js"

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const orgId = `org_reconcile_${suffix}`
const ids = {
  github: `con_reconcile_github_${suffix}`,
  slack: `con_reconcile_slack_${suffix}`,
  notion: `con_reconcile_notion_${suffix}`,
  forge: `con_reconcile_forge_${suffix}`,
  deleted: `con_reconcile_deleted_${suffix}`,
}

let owner: pg.Pool

async function directory() {
  const { rows } = await owner.query(
    `SELECT connection_id, org_id, type, github_installation_id, slack_team_id,
            linear_workspace_id, notion_workspace_id, notion_bot_id,
            forge_cloud_id, forge_installation_id
     FROM connection_directory WHERE org_id = $1 ORDER BY connection_id`,
    [orgId],
  )
  return rows
}

describeWithDatabase("reconcileConnectionDirectory (Postgres)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    owner = new pg.Pool({
      connectionString: ownerUrlForMigrate(process.env.DATABASE_URL),
    })
    await owner.query(
      `INSERT INTO organizations (id, name, slug, created_at) VALUES ($1, 'Reconcile', $2, now())`,
      [orgId, `reconcile-${suffix}`],
    )
    // Code from before the directory wrote these connections, and wrote no
    // directory rows.
    await owner.query(
      `INSERT INTO connections (id, org_id, type, config) VALUES
        ($1, $5, 'github', '{"installationId": 4242}'),
        ($2, $5, 'slack', '{"teamId": "T_NEW"}'),
        ($3, $5, 'notion', '{"workspaceId": " ws-1 ", "botId": ""}'),
        ($4, $5, 'forge', '{"cloudId": "cloud-1", "installationId": "inst-1"}')`,
      [ids.github, ids.slack, ids.notion, ids.forge, orgId],
    )
    // A stale row: the team of the Slack connection changed.
    await owner.query(
      `INSERT INTO connection_directory (connection_id, org_id, type, slack_team_id) VALUES ($1, $2, 'slack', 'T_OLD')`,
      [ids.slack, orgId],
    )
    // An orphan: the connection was deleted, and its directory row stayed.
    await owner.query(
      `INSERT INTO connection_directory (connection_id, org_id, type, slack_team_id) VALUES ($1, $2, 'slack', 'T_GONE')`,
      [ids.deleted, orgId],
    )
  })

  afterAll(async () => {
    await owner?.query(`DELETE FROM connection_directory WHERE org_id = $1`, [
      orgId,
    ])
    await owner?.query(`DELETE FROM connections WHERE org_id = $1`, [orgId])
    await owner?.query(`DELETE FROM organizations WHERE id = $1`, [orgId])
    await owner?.end()
  })

  it("adds missing rows, fixes stale rows and deletes orphans for every type, and a second run changes nothing", async () => {
    const empty = {
      github_installation_id: null,
      slack_team_id: null,
      linear_workspace_id: null,
      notion_workspace_id: null,
      notion_bot_id: null,
      forge_cloud_id: null,
      forge_installation_id: null,
    }
    const expected = [
      {
        ...empty,
        connection_id: ids.forge,
        type: "forge",
        forge_cloud_id: "cloud-1",
        forge_installation_id: "inst-1",
      },
      {
        ...empty,
        connection_id: ids.github,
        type: "github",
        github_installation_id: "4242",
      },
      {
        ...empty,
        connection_id: ids.notion,
        type: "notion",
        notion_workspace_id: "ws-1",
      },
      { ...empty, connection_id: ids.slack, type: "slack", slack_team_id: "T_NEW" },
    ]
      .map((row) => ({ ...row, org_id: orgId }))
      .sort((a, b) => a.connection_id.localeCompare(b.connection_id))

    await reconcileConnectionDirectory(owner)
    expect(await directory()).toEqual(expected)

    await reconcileConnectionDirectory(owner)
    expect(await directory()).toEqual(expected)
  })

  it("refuses a role that RLS filters, so it never empties the directory", async () => {
    const appUrl = new URL(process.env.DATABASE_URL ?? "")
    if (appUrl.username !== "ctxpipe_app")
      throw new Error("DATABASE_URL must name the ctxpipe_app role")
    const app = new pg.Pool({ connectionString: appUrl.toString() })
    try {
      await expect(reconcileConnectionDirectory(app)).rejects.toThrow(
        /needs the owner of connections/,
      )
    } finally {
      await app.end()
    }
    expect(await directory()).toHaveLength(4)
  })
})
