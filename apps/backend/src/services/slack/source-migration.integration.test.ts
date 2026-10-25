import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { handOverLegacyBindings } from "../../domain/workspace-sources/legacy-handover.js"
import { planSourceMigration } from "../../domain/workspace-sources/migration-plan.js"
import { seedSourcesOrg } from "../../test/workspace-sources-fixture.js"
import {
  planSlackLegacyMoves,
  slackLegacyBindings,
  slackSourceMigrationHook,
} from "./source-migration.js"

const execFileAsync = promisify(execFile)

// The paths that the mention capture wrote into the bound repository before
// ADR-050 (`slack/channels/<slug>--<id>/…`). Names and ids are made up.
const OLD_CAPTURE_PATHS = [
  "README.md",
  "slack/channels/eng--C0ENG0001/index.md",
  "slack/channels/eng--C0ENG0001/threads/2026/09/1790000000.000100/thread.md",
  "slack/channels/eng--C0ENG0001/threads/2026/09/1790000000.000100/assets/F0001-diagram.png",
  "slack/channels/eng--C0ENG0001/threads/2026/10/1790500000.000100/thread.md",
  "slack/channels/private-ops--G0OPS0001/index.md",
  "slack/channels/private-ops--G0OPS0001/threads/2026/10/1790600000.000100/thread.md",
  "slack/README.md",
]
const CONTEXT_REPO = "https://github.com/example/context.git"

describe("slackLegacyBindings", () => {
  it("maps the captured channels of the bound repository to one source", () => {
    const bindings = slackLegacyBindings({
      connectionId: "con_slack1",
      syncRepositoryUrl: CONTEXT_REPO,
      paths: OLD_CAPTURE_PATHS,
    })
    expect(bindings).toEqual([
      {
        provider: "slack",
        connectionId: "con_slack1",
        syncRepositoryUrl: CONTEXT_REPO,
        scope: { channels: ["C0ENG0001", "G0OPS0001"] },
        ownRepositoryOnly: true,
      },
    ])
    const plan = planSourceMigration({
      workspaces: [
        {
          id: "ws_context",
          workspaceRepositoryUrl: CONTEXT_REPO,
          githubConnectionId: null,
          sourcesFile: null,
        },
        {
          id: "ws_linker",
          workspaceRepositoryUrl: "https://github.com/example/linker.git",
          githubConnectionId: null,
          sourcesFile: null,
        },
      ],
      // A Workspace that only links the bound repository does not get it.
      linked: [{ workspaceId: "ws_linker", gitUrl: CONTEXT_REPO }],
      bindings,
    })
    expect(plan.report.moved).toEqual([
      {
        workspaceId: "ws_context",
        provider: "slack",
        connectionId: "con_slack1",
      },
    ])
  })

  it("moves the old capture directories to the managed paths by blob sha in real git", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctxpipe-slack-mig-"))
    try {
      const git = async (...args: string[]) =>
        (await execFileAsync("git", ["-C", dir, ...args])).stdout
      await git("init", "-q", "-b", "main")
      await git("config", "user.email", "dev@example.com")
      await git("config", "user.name", "Dev")
      for (const path of OLD_CAPTURE_PATHS) {
        await mkdir(dirname(join(dir, path)), { recursive: true })
        await writeFile(
          join(dir, path),
          // An asset over 1 MB: the move must not read it.
          path.endsWith(".png") ? Buffer.alloc(1_500_000, 0xab) : `# ${path}\n`,
        )
      }
      await git("add", "-A")
      await git("commit", "-q", "-m", "Old captures")
      const files = (await git("ls-tree", "-r", "HEAD"))
        .trim()
        .split("\n")
        .map((line) => {
          const [meta, path] = line.split("\t")
          return { path: path ?? "", sha: meta?.split(" ")[2] ?? "" }
        })
      const moves = await planSlackLegacyMoves({ files })
      expect(moves).toHaveLength(6)
      // Write the moves as tree entries by blob sha, as the migration commit does.
      for (const move of moves) {
        await git(
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${move.sha},${move.to}`,
        )
        await git("rm", "--cached", "-q", move.from)
      }
      await git("commit", "-q", "-m", "Move connector sources")
      const renames = (
        await git("diff", "-M", "--name-status", "HEAD~1", "HEAD")
      )
        .trim()
        .split("\n")
      expect(renames).toHaveLength(6)
      for (const line of renames) expect(line).toMatch(/^R100\t/)
      const tree = (await git("ls-tree", "-r", "--name-only", "HEAD"))
        .trim()
        .split("\n")
      expect(tree.filter((path) => path.includes("--"))).toEqual([])
      expect(tree).toContain(
        "slack/channels/C0ENG0001/threads/2026/09/1790000000.000100/assets/F0001-diagram.png",
      )
      expect(tree).toContain("slack/README.md")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("reports a bound repository without captures as unmapped", () => {
    expect(
      slackLegacyBindings({
        connectionId: "con_slack1",
        syncRepositoryUrl: CONTEXT_REPO,
        paths: ["README.md", "slack/README.md"],
      }),
    ).toEqual([
      {
        provider: "slack",
        connectionId: "con_slack1",
        unmapped: expect.stringContaining("no captured Slack threads"),
      },
    ])
  })
})

describe("Slack source migration hook (Postgres)", () => {
  let seed: Awaited<ReturnType<typeof seedSourcesOrg>>
  let bound: string
  // The config that the Slack setup wrote before ADR-050: auth plus the
  // capture repository binding. Values are made up.
  const oldConfig = (suffix: string) => ({
    teamId: `T0${suffix}`.toUpperCase().slice(0, 20),
    teamName: "Example",
    botUserId: "U0BOT0001",
    botHandle: "ctxpipe",
    status: "installed",
    repositoryId: `repo_ctx_${suffix}`,
    branch: "main",
    enabled: true,
  })

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for this integration test")
    seed = await seedSourcesOrg("slack_mig")
    bound = await seed.addConnection("slack", oldConfig(seed.suffix))
  })
  afterAll(async () => {
    await seed.cleanup()
  })

  it("reports a connection whose bound repository is gone as unmapped", async () => {
    expect(
      await slackSourceMigrationHook.listLegacyBindings({
        orgId: seed.orgId,
        env: parseEnv(process.env),
      }),
    ).toEqual([
      {
        provider: "slack",
        connectionId: bound,
        unmapped: expect.stringContaining("no capture repository"),
      },
    ])
  })

  it("turns off the old binding and keeps the rest of the config", async () => {
    await slackSourceMigrationHook.disableLegacy?.({
      orgId: seed.orgId,
      connectionId: bound,
    })
    const [row] = await withOrgDbContext(seed.orgId, (db) =>
      db.select().from(connections).where(eq(connections.id, bound)),
    )
    expect(row?.config).toMatchObject({
      ...oldConfig(seed.suffix),
      enabled: false,
    })
  })

  it("keeps the old binding on until a source of the connection projects in the bound Workspace", async () => {
    // The migration PR is open, not merged: the old binding still captures.
    const repositoryId = `repo_ctx_${seed.suffix}_handover`
    const repositoryUrl = `https://github.com/example/handover-${seed.suffix}.git`
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: `example/handover-${seed.suffix}`,
        gitUrl: repositoryUrl,
      }),
    )
    const connectionId = await seed.addConnection("slack", {
      ...oldConfig(seed.suffix),
      teamId: `T1${seed.suffix}`.toUpperCase().slice(0, 20),
      repositoryId,
    })
    const bound = await seed.addWorkspace("bound", repositoryUrl)
    const other = await seed.addWorkspace("other")
    const enabled = async () => {
      const [row] = await withOrgDbContext(seed.orgId, (db) =>
        db.select().from(connections).where(eq(connections.id, connectionId)),
      )
      return (row?.config as { enabled?: boolean }).enabled
    }
    const row = {
      provider: "slack" as const,
      connectionId,
      scope: { channels: ["C0ENG0001"] },
      status: "ok" as const,
    }
    // A source in another Workspace does not hand the binding over.
    await handOverLegacyBindings({
      orgId: seed.orgId,
      workspaceId: other,
      rows: [row],
    })
    expect(await enabled()).toBe(true)
    // The first projection in the bound Workspace (after the merge) does.
    await handOverLegacyBindings({
      orgId: seed.orgId,
      workspaceId: bound,
      rows: [row],
    })
    expect(await enabled()).toBe(false)
    await withOrgDbContext(seed.orgId, (db) =>
      db.delete(repositories).where(eq(repositories.id, repositoryId)),
    )
  })
})
