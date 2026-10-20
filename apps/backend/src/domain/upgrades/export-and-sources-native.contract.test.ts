import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { claims } from "../../db/schema/claims.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { workspaces, workspaceWriteJobs } from "../../db/schema/workspaces.js"
import { getWorkspaceUpgradeRow } from "../../models/workspace-upgrades.js"
import { persistOrgFirstWorkspace } from "../../models/workspaces.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { readGitPackFromRemote } from "../../services/git/pack.js"
import { usePlainGitNetwork } from "../../services/git/plain-git-remote.js"
import { seedLegacyExtractionObject } from "../../test/legacy-extraction-fixture.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { workspacePublishPipeline } from "../ingestion/ingestion-v2-config.js"
import { readIngestSkillBundle } from "../ingestion/skill-bundle.js"
import { ensureOrgRepositoryForGitUrl } from "../workspaces/ensure-org-repository.js"
import { KNOWLEDGE_SKILL_PATH } from "../workspaces/layout.js"
import { WORKSPACE_FORMAT_PATH } from "../workspaces/workspace-format.js"
import { buildUpgradeCommits } from "./build-commits.js"
import {
  GIT_UPGRADE_STEPS,
  UPGRADE_JOB_KIND,
  upgradeBranch,
} from "./registry.js"
import { reingestUpgradeKey, workspaceSourceRepositories } from "./reingest.js"
import { startWorkspaceUpgrade } from "./start.js"

// The DNS of the test: each plain git host resolves to a public address.
let restoreNetwork = () => {}
beforeAll(() => {
  restoreNetwork = usePlainGitNetwork({
    lookup: async () => [{ address: "93.184.215.14" }],
  })
})
afterAll(() => restoreNetwork())

const KEY = "format-3"
const BRANCH = upgradeBranch(3)
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
    // A port that is not the default: ctx| does not read it as plain git.
    const gitlab = await ensureOrgRepositoryForGitUrl({
      orgId: f.org.id,
      gitUrl: "https://gitlab.com:8443/team-c/tools.git",
    })
    // A public HTTPS repository with no GitHub connection: main read it
    // with no credential, and step 1 makes it a plain git source (CTX-815).
    const plain = await ensureOrgRepositoryForGitUrl({
      orgId: f.org.id,
      gitUrl: "https://git.example.org/team-d/plain.git",
    })
    if (!own || !github || !gitlab || !plain)
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
    // Kept: fresh ingestion cannot read this repository.
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
    await seed("Service", `svc:${plain.id}:plain`, {
      name: "Plain service",
      summary: "Old pipeline text.",
    })
    // Kept: ingestion v2 does not ingest the Workspace repository.
    await seed("Service", `svc:${own.id}:context`, {
      name: "Context notes",
      summary: "Old pipeline text.",
    })
    await seed("Issue", "iss:linear:ENG-1", { title: "ENG-1 Fix the build" })
    // Not exported: main deleted this repository, so no source reads it.
    await seed("Service", "svc:repo_deletedexample:billing", {
      name: "Old billing",
      summary: "Old pipeline text.",
    })
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
  "takes a format 0 main-era Workspace through the three upgrade steps in one pull request, and after the merge hydrate puts it on ingestion v2 with no direct write to the default branch",
  { timeout: 240_000 },
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
          // A person links to a unit with no claim. Below format 3 hydrate
          // does not add the claim: step 3 adds it in the pull request.
          {
            path: "guides/release.md",
            body: "# Release\nUse [the tools](../knowledge/services/tools-cli.md).\n",
          },
          // The old pipeline extracted this file. Step 3 moves it to
          // ingestion v2 ownership.
          {
            path: "knowledge/services/api-gateway.md",
            body: "---\nkind: Service\ngenerated_by: ctxpipe\nsource: https://github.com/team-a/api.git#src/index.ts\n---\n\n# API gateway\n",
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
        // The fixture queues a hydrate of the format 0 tree. This test
        // hydrates only the merged upgrade.
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
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

          // The production registry offers the three steps to a format 0
          // Workspace, in one pull request.
          const scan = await runner.runWorkflow(workspaceUpgradeScan.spec, {
            orgId: f.org.id,
            release: "test",
            trigger: "first",
          })
          await scan.result({ timeoutMs: 30_000 })
          expect(await row()).toMatchObject({
            status: "awaiting_operator",
            upgrade: { fromFormat: 0, targetFormat: 3, branch: BRANCH },
          })
          // The Workspace has no source rows yet. The re-ingestion shows the
          // repositories that step 1 links (the GitHub org repository, the
          // repository file, and the plain git org repository; not the
          // GitLab ones), blocked on the format.
          const reingest = await withOrgIdContext(f.org, async () =>
            getWorkspaceUpgradeRow(
              f.workspaceId,
              reingestUpgradeKey((await readIngestSkillBundle()).name),
            ),
          )
          expect(reingest).toMatchObject({
            status: "blocked",
            upgrade: {
              blockedReason: "needs_format",
              fromFormat: 0,
              targetFormat: 3,
            },
          })
          expect(
            reingest?.upgrade.estimate?.perRepository.map(
              (entry) => entry.repository,
            ),
          ).toEqual([
            "existing/api",
            "git.example.org/team-d/plain",
            "team-a/api",
          ])

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
            "ctx| upgrade: set the Workspace format to 3",
            "ctx| upgrade to format 3: Ingestion v2 ownership of extracted files",
            "ctx| upgrade to format 2: One file for each source under sources/",
            "ctx| upgrade to format 1: Move the sources and keep the old knowledge",
            "Immutable fixture",
          ])
          expect(
            f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main"),
          ).toBe(f.sha)
          expect(show(WORKSPACE_FORMAT_PATH)).toContain("format: 3")

          // Sources: step 1 puts the GitHub org repository, the GitHub
          // repository file and the Linear connection scope into
          // `.ctxpipe/sources.yaml`. Step 2 makes one file for each source.
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
          expect(files).not.toContain(".ctxpipe/sources.yaml")
          const sourceFiles = files.filter((path) =>
            path.startsWith("sources/"),
          )
          const sources = sourceFiles.map(show).join("\n")
          expect(sourceFiles).toEqual(
            expect.arrayContaining([
              "sources/github/team-a/api.md",
              "sources/github/existing/api.md",
              "sources/git/git.example.org/team-d-plain.md",
            ]),
          )
          expect(show("sources/git/git.example.org/team-d-plain.md")).toBe(
            "---\nprovider: git\nurl: https://git.example.org/team-d/plain\n---",
          )
          expect(sources).not.toContain("gitlab.com")
          expect(sources).toContain("provider: linear")
          expect(sources).toContain("ENG")
          const gateway = show("knowledge/services/api-gateway.md")
          expect(gateway).toContain("generated_by: ctxpipe-extract")
          expect(gateway).toContain("sources/github/team-a/api.md")
          // Step 3 makes the changes that hydrate makes at format 3: the
          // claim of a link, its valid_from, and the bootstrap files.
          const release = show("guides/release.md")
          expect(release).toContain("to: ../knowledge/services/tools-cli.md")
          expect(release).toMatch(/valid_from: "?\d{4}-\d{2}-\d{2}T/)
          expect(files).toContain("AGENTS.md")
          expect(files).toContain(KNOWLEDGE_SKILL_PATH)
          expect(show("AGENTS.md")).toContain("## Folder Structure")

          // Knowledge: only the items of the repository that fresh
          // ingestion cannot read. The file of the person stays as it is.
          expect(show("knowledge/services/tools-cli.md")).toBe(
            "# Tools CLI\nWritten by a person.",
          )
          const exported = files.filter(
            (path) =>
              path.startsWith("knowledge/") &&
              path !== "knowledge/services/tools-cli.md" &&
              path !== "knowledge/services/api-gateway.md",
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
          // Step 3 removes the import key that step 1 wrote.
          expect(toolsText).not.toContain("import_key:")
          expect(toolsText).toContain("valid_from:")
          expect(toolsText).toContain("The release tools.")
          expect(toolsText).toContain("predicate: USES")
          expect(toolsText).toContain(
            "https://gitlab.com:8443/team-c/tools.git#cmd/tools/main.go",
          )
          // The code knowledge of the Workspace repository is kept too.
          expect(exported.map(show).join("\n")).toContain("Context notes")
          for (const path of exported)
            expect(show(path)).not.toMatch(/Public API|Plain service|ENG-1/)

          // The pull request body has the list of kept and rebuilt content.
          expect(opened).toHaveLength(1)
          expect(opened[0]).toMatchObject({ head: BRANCH, base: "main" })
          const body = opened[0]?.body ?? ""
          expect(body).toContain(
            "Kept 2 knowledge item(s) from https://gitlab.com:8443/team-c/tools in `knowledge/`",
          )
          expect(body).toContain(
            "Not exported, because ctx| makes it again: 2 item(s) from source repositories (the re-ingestion upgrade), 0 item(s) from Workspace repositories and 1 connector item(s)",
          )
          expect(body).toContain(
            "Not exported: 1 item(s) from a deleted repository.",
          )
          expect(body).toContain("Removed `repositories/api.md`")
          expect(body).toContain(
            "Not linked: repositories/tools.md. ctx| links only GitHub repositories.",
          )
          expect(body).toContain("Added a Linear source")
          expect(body).toContain(
            "Linked https://git.example.org/team-d/plain as a plain git source in `sources/git/git.example.org/team-d-plain.md`.",
          )
          expect(body).toContain(
            "Not linked: https://gitlab.com:8443/team-c/tools. ctx| does not read it as a plain git source: A plain git URL must use the default HTTPS port. Plain git sources must use an https:// URL. ssh (git@… or ssh://), git:// and file:// are not supported. ctx| keeps its knowledge and exports it.",
          )

          // A second plan of each step, on the commit that it made, changes
          // nothing.
          const head = f.git(
            "--git-dir",
            f.remote,
            "rev-parse",
            `refs/heads/${BRANCH}`,
          )
          const stepCommits = f
            .git(
              "--git-dir",
              f.remote,
              "rev-list",
              "--reverse",
              `${f.sha}..${head}`,
            )
            .split("\n")
          expect(stepCommits).toHaveLength(4)
          for (const step of GIT_UPGRADE_STEPS) {
            const at = stepCommits[step.format - 1] ?? ""
            const again = await withOrgIdContext(f.org, async () =>
              buildUpgradeCommits({
                pack: await readGitPackFromRemote({ url: f.remote, sha: at }),
                steps: GIT_UPGRADE_STEPS.slice(0, step.format),
                fromFormat: step.format - 1,
                targetFormat: step.format,
                ctx: {
                  orgId: f.org.id,
                  workspaceId: f.workspaceId,
                  baseSha: at,
                  remote: { url: f.workspaceUrl, connectionId: f.connectionId },
                },
                createdAt: "2026-10-16T00:00:00.000Z",
              }),
            )
            expect(again.steps).toEqual([
              expect.objectContaining({ format: step.format, sha: null }),
            ])
          }

          // The pull request merges: the default branch gets its head.
          f.git(
            "--git-dir",
            f.remote,
            "update-ref",
            "refs/heads/main",
            head,
            f.sha,
          )
          const revision = await f.resolveRevision(true)
          expect(revision.sha).toBe(head)
          const { workspaceHydrate } = await import(
            "../../openworkflow/workflows/workspace-hydrate.js"
          )
          await f.worker.start()
          const hydrate = await f.runner.runWorkflow(workspaceHydrate.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision,
          })
          expect(await hydrate.result({ timeoutMs: 60_000 })).toMatchObject({
            hydrated: true,
          })
          await expect
            .poll(async () => (await row())?.status, { timeout: 60_000 })
            .toBe("completed")
          // Hydrate queues no direct write to the default branch: the
          // upgrade pull request made each change, also the bootstrap files.
          const writeJobs = await withOrgDbContext(f.org.id, (db) =>
            db
              .select({ kind: workspaceWriteJobs.kind })
              .from(workspaceWriteJobs)
              .where(eq(workspaceWriteJobs.workspaceId, f.workspaceId)),
          )
          // Each row is an upgrade item: the format upgrade, and the
          // re-ingestion that the scan offers after the merge.
          expect(new Set(writeJobs.map((job) => job.kind))).toEqual(
            new Set([UPGRADE_JOB_KIND]),
          )
          const runNames = [
            ...(await backend.listWorkflowRuns({ limit: 500 })).data,
            ...(await f.backend.listWorkflowRuns({ limit: 500 })).data,
          ].map((run) => run.workflowName)
          expect(runNames).not.toContain("workspace-unlink-retraction")
          expect(runNames).not.toContain("workspace-ownership-migration")
          // The format is the one switch: the Workspace is on ingestion v2.
          const [workspace] = await withOrgDbContext(f.org.id, (db) =>
            db
              .select({ formatVersion: workspaces.formatVersion })
              .from(workspaces)
              .where(eq(workspaces.id, f.workspaceId)),
          )
          expect(workspace?.formatVersion).toBe(3)
          expect(
            workspacePublishPipeline(workspace?.formatVersion ?? null),
          ).toBe("v2")
          // After the merge, the re-ingestion reads the projected source
          // files: the main-era plain git repository is in its list.
          expect(
            (await workspaceSourceRepositories(f.org.id, f.workspaceId)).map(
              (entry) => [entry.repository, entry.githubConnectionId],
            ),
          ).toEqual([
            ["existing/api", f.connectionId],
            ["git.example.org/team-d/plain", null],
            ["team-a/api", f.connectionId],
          ])
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
            upgrade: { blockedReason: "write_access", targetFormat: 3 },
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
