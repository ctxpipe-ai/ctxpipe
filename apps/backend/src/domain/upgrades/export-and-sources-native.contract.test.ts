import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { claims } from "../../db/schema/claims.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { getWorkspaceUpgradeRow } from "../../models/workspace-upgrades.js"
import { persistOrgFirstWorkspace } from "../../models/workspaces.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { readGitPackFromRemote } from "../../services/git/pack.js"
import { seedLegacyExtractionObject } from "../../test/legacy-extraction-fixture.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "../workspaces/ensure-org-repository.js"
import { WORKSPACE_FORMAT_PATH } from "../workspaces/workspace-format.js"
import { buildUpgradeCommits } from "./build-commits.js"
import { GIT_UPGRADE_STEPS, upgradeBranch } from "./registry.js"
import { startWorkspaceUpgrade } from "./start.js"

const KEY = "format-1"
const BRANCH = upgradeBranch(1)
const PULLS = "https://api.github.com/repos/fixture/hydration-contract/pulls"
const LINEAR_WORKSPACE = "5f0c1d2e-aaaa-4bbb-8ccc-000000000001"

// The `linear/config.yaml` that the Linear setup of main wrote to the
// connector sync repository. Names and ids are made up.
const LINEAR_CONFIG = `version: 1
source: linear
workspace:
  id: ${LINEAR_WORKSPACE}
  name: Example Co
scope:
  teams:
    - id: 7a1b2c3d-aaaa-4bbb-8ccc-000000000010
      name: Engineering
      key: ENG
      teamId: 7a1b2c3d-aaaa-4bbb-8ccc-000000000010
      teamKey: ENG
      url: https://linear.app/example/team/ENG
  projects: []
  documents: []
  initiatives: []
`

/**
 * Seed the Postgres data of a main-era org: the org repositories, the
 * first Workspace (the old connector sync repository), a Linear connection
 * that synced to it, and the knowledge of main's code ingestion.
 */
async function seedMainEraOrg(f: NativeHydrationFixture) {
  await withOrgIdContext(f.org, async () => {
    const own = await ensureOrgRepositoryForGitUrl({
      orgId: f.org.id,
      gitUrl: f.workspaceUrl,
      githubConnectionId: f.connectionId,
    })
    const github = await ensureOrgRepositoryForGitUrl({
      orgId: f.org.id,
      gitUrl: "https://github.com/team-a/api.git",
    })
    const gitlab = await ensureOrgRepositoryForGitUrl({
      orgId: f.org.id,
      gitUrl: "https://gitlab.com/team-c/tools.git",
    })
    if (!own || !github || !gitlab)
      throw new Error("The org repositories were not created")
    // Main recorded the GitHub connection of each GitHub repository.
    await withOrgDbContext(f.org.id, (db) =>
      db
        .update(repositories)
        .set({ githubConnectionId: f.connectionId })
        .where(eq(repositories.id, github.id)),
    )
    await persistOrgFirstWorkspace({
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      sourceRepositoryId: own.id,
    })
    await withOrgDbContext(f.org.id, (db) =>
      db.insert(connections).values({
        id: `con_linear_${f.id}`,
        orgId: f.org.id,
        type: "linear",
        config: {
          status: "installed",
          workspaceId: LINEAR_WORKSPACE,
          workspaceName: "Example Co",
          repositoryId: own.id,
          branch: "main",
        },
      }),
    )
    const seed = (
      kind: string,
      deduplicationKey: string,
      payload: Record<string, unknown>,
    ) =>
      withOrgDbContext(f.org.id, () =>
        seedLegacyExtractionObject(f.org.id, {
          kind,
          deduplicationKey,
          payload,
        }),
      )
    // Kept: fresh ingestion reads only GitHub repositories.
    const tools = await seed("Service", `svc:${gitlab.id}:tools`, {
      name: "Tools CLI",
      summary: "The release tools.",
      path: "cmd/tools/main.go",
    })
    const parser = await seed("Library", `lib:${gitlab.id}:parser`, {
      name: "Parser",
      summary: "Reads the release manifest.",
    })
    // Not exported: the re-ingestion upgrade makes them again.
    await seed("Service", `svc:${github.id}:api`, {
      name: "Public API",
      summary: "Old pipeline text.",
    })
    // Kept: ingestion v2 does not ingest the Workspace repository.
    await seed("Service", `svc:${own.id}:context`, {
      name: "Context notes",
      summary: "Old pipeline text.",
    })
    await seed("Issue", "iss:linear:ENG-1", { title: "ENG-1 Fix the build" })
    const now = new Date("2026-01-01T00:00:00Z")
    await withOrgDbContext(f.org.id, (db) =>
      db.insert(claims).values({
        id: `clm_${f.id}_uses`,
        orgId: f.org.id,
        subjectId: tools.id,
        objectId: parser.id,
        predicate: "USES",
        status: "active",
        aggregatedConfidence: 0.9,
        firstObservedAt: now,
        lastObservedAt: now,
      }),
    )
  })
}

it(
  "puts the sources and the kept knowledge of a main-era Workspace into the upgrade pull request, and never into the default branch",
  { timeout: 150_000 },
  async () => {
    const opened: Array<{ head: string; base: string; body: string }> = []
    let openPulls: unknown[] = []
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        githubContentFiles: { "linear/config.yaml": LINEAR_CONFIG },
        files: [
          { path: "README.md", body: "# Context\n" },
          { path: "linear/config.yaml", body: LINEAR_CONFIG },
          {
            path: "repositories/api.md",
            body: "---\ngit: https://github.com/existing/api.git\n---\n",
          },
          {
            path: "repositories/tools.md",
            body: "---\ngit: https://gitlab.com/existing/tools.git\n---\n",
          },
          // A person wrote this file at the path that the export prefers.
          {
            path: "knowledge/services/tools-cli.md",
            body: "# Tools CLI\nWritten by a person.\n",
          },
        ],
        onGithubPullRequest: (body) => {
          const pull = body as (typeof opened)[number]
          opened.push(pull)
          openPulls = [
            {
              number: 7,
              html_url: "https://github.com/fixture/hydration-contract/pull/7",
              head: { ref: pull.head },
              created_at: "2026-10-16T00:00:00Z",
            },
          ]
        },
      },
      async (f) => {
        await seedMainEraOrg(f)
        f.server.use(http.get(PULLS, () => HttpResponse.json(openPulls)))
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { workspaceUpgradeScan } = await import(
          "../../openworkflow/workflows/workspace-upgrade-scan.js"
        )
        const { workspaceUpgrade } = await import(
          "../../openworkflow/workflows/workspace-upgrade.js"
        )
        const { workspaceTipCheck } = await import(
          "../../openworkflow/workflows/workspace-tip-check.js"
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(
          workspaceUpgradeScan.spec,
          workspaceUpgradeScan.fn,
        )
        runner.implementWorkflow(workspaceUpgrade.spec, workspaceUpgrade.fn)
        runner.implementWorkflow(workspaceTipCheck.spec, workspaceTipCheck.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        const row = () =>
          withOrgIdContext(f.org, () =>
            getWorkspaceUpgradeRow(f.workspaceId, KEY),
          )
        const show = (path: string) =>
          f.git("--git-dir", f.remote, "show", `refs/heads/${BRANCH}:${path}`)
        try {
          await worker.start()
          // The tip check runs on each deploy and webhook. It writes
          // nothing to the default branch and queues no direct export.
          const tip = await runner.runWorkflow(workspaceTipCheck.spec, {
            orgId: f.org.id,
          })
          await tip.result({ timeoutMs: 60_000 })
          expect(
            (await backend.listWorkflowRuns({ limit: 200 })).data.filter(
              (run) => run.workflowName === "workspace-write-migration-export",
            ),
          ).toEqual([])
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(f.sha)

          // The production registry offers step 1 to a format 0 Workspace.
          const scan = await runner.runWorkflow(workspaceUpgradeScan.spec, {
            orgId: f.org.id,
            release: "test",
            trigger: "first",
          })
          await scan.result({ timeoutMs: 30_000 })
          expect(await row()).toMatchObject({
            status: "awaiting_operator",
            upgrade: { fromFormat: 0, targetFormat: 1, branch: BRANCH },
          })

          // The click of an owner or admin.
          expect(
            await withOrgIdContext(f.org, () =>
              startWorkspaceUpgrade({
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                key: KEY,
                userId: "user_admin",
              }),
            ),
          ).toMatchObject({ kind: "queued" })
          await expect
            .poll(async () => (await row())?.status, { timeout: 90_000 })
            .toBe("pr_open")
          expect((await row())?.failureReason ?? null).toBeNull()

          expect(
            f
              .git(
                "--git-dir",
                f.remote,
                "log",
                "--format=%s",
                `refs/heads/${BRANCH}`,
              )
              .split("\n"),
          ).toEqual([
            "ctx| upgrade: set the Workspace format to 1",
            "ctx| upgrade to format 1: Move the sources and keep the old knowledge",
            "Immutable fixture",
          ])
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(f.sha)
          expect(show(WORKSPACE_FORMAT_PATH)).toContain("format: 1")

          // Sources: the GitHub org repository, the GitHub repository file,
          // and the Linear connection scope.
          const sources = show(".ctxpipe/sources.yaml")
          expect(sources).toContain("team-a/api")
          expect(sources).toContain("existing/api")
          expect(sources).not.toContain("gitlab.com")
          expect(sources).toContain("provider: linear")
          expect(sources).toContain("ENG")
          const files = f
            .git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              `refs/heads/${BRANCH}`,
            )
            .split("\n")
          expect(files).not.toContain("repositories/api.md")
          expect(files).toContain("repositories/tools.md")

          // Knowledge: only the items of the repository that is not on
          // GitHub. The file of the person stays as it is.
          expect(show("knowledge/services/tools-cli.md")).toBe(
            "# Tools CLI\nWritten by a person.",
          )
          const exported = files.filter(
            (path) =>
              path.startsWith("knowledge/") &&
              path !== "knowledge/services/tools-cli.md",
          )
          expect(exported).toHaveLength(3)
          const toolsFile = exported.find((path) =>
            show(path).includes("The release tools."),
          )
          const parserFile = exported.find((path) =>
            path.startsWith("knowledge/libraries/"),
          )
          expect(toolsFile).toBeDefined()
          expect(parserFile).toBeDefined()
          const toolsText = show(toolsFile ?? "")
          expect(toolsText).toContain("import_key:")
          expect(toolsText).toContain("The release tools.")
          expect(toolsText).toContain("predicate: USES")
          expect(toolsText).toContain(
            "https://gitlab.com/team-c/tools.git#cmd/tools/main.go",
          )
          // The code knowledge of the Workspace repository is kept too.
          expect(exported.map(show).join("\n")).toContain("Context notes")
          for (const path of exported)
            expect(show(path)).not.toMatch(/Public API|ENG-1/)

          // The pull request body has the list of kept and rebuilt content.
          expect(opened).toHaveLength(1)
          expect(opened[0]).toMatchObject({ head: BRANCH, base: "main" })
          const body = opened[0]?.body ?? ""
          expect(body).toContain(
            "Kept 2 knowledge item(s) from https://gitlab.com/team-c/tools in `knowledge/`",
          )
          expect(body).toContain(
            "Not exported, because ctx| makes it again: 1 item(s) from GitHub repositories (the re-ingestion upgrade), 0 item(s) from Workspace repositories and 1 connector item(s)",
          )
          expect(body).toContain("Removed `repositories/api.md`")
          expect(body).toContain(
            "Not linked: repositories/tools.md. ctx| links only GitHub repositories.",
          )
          expect(body).toContain("Added a Linear source")

          // A second plan on the output of step 1 changes nothing.
          const head = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            `refs/heads/${BRANCH}`,
          )
          const rerun = await withOrgIdContext(f.org, async () =>
            buildUpgradeCommits({
              pack: await readGitPackFromRemote({ url: f.remote, sha: head }),
              steps: GIT_UPGRADE_STEPS,
              fromFormat: 0,
              targetFormat: 1,
              ctx: {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                baseSha: head,
                remote: { url: f.workspaceUrl, connectionId: f.connectionId },
              },
              createdAt: "2026-10-16T00:00:00.000Z",
            }),
          )
          expect(rerun.steps).toEqual([
            expect.objectContaining({ format: 1, sha: null }),
          ])
          expect(rerun.pack.sha).toBe(head)
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)

it(
  "shows step 1 as blocked on write access, with no write, when ctx| cannot write to the repository",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "missing",
        writeStatus: "read_only",
        files: [{ path: "README.md", body: "# Context\n" }],
      },
      async (f) => {
        await seedMainEraOrg(f)
        f.server.use(http.get(PULLS, () => HttpResponse.json([])))
        const { BackendPostgres } = await import("openworkflow/postgres")
        const { OpenWorkflow } = await import("openworkflow")
        const { workspaceUpgradeScan } = await import(
          "../../openworkflow/workflows/workspace-upgrade-scan.js"
        )
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          namespaceId: openWorkflowNamespaceId(),
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(
          workspaceUpgradeScan.spec,
          workspaceUpgradeScan.fn,
        )
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          const scan = await runner.runWorkflow(workspaceUpgradeScan.spec, {
            orgId: f.org.id,
            release: "test",
            trigger: "first",
          })
          await scan.result({ timeoutMs: 30_000 })
          expect(
            await withOrgIdContext(f.org, () =>
              getWorkspaceUpgradeRow(f.workspaceId, KEY),
            ),
          ).toMatchObject({
            status: "blocked",
            upgrade: { blockedReason: "write_access", targetFormat: 1 },
          })
          const runs = (await backend.listWorkflowRuns({ limit: 200 })).data
          expect(
            runs.filter((run) =>
              [
                "workspace-upgrade",
                "workspace-write-migration-export",
              ].includes(run.workflowName),
            ),
          ).toEqual([])
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(f.sha)
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    ),
)
