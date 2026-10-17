import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { claims } from "../../db/schema/claims.js"
import { objects } from "../../db/schema/objects.js"
import { repositories } from "../../db/schema/repositories.js"
import { orgFirstWorkspaces } from "../../db/schema/workspaces.js"
import {
  getWorkspaceUpgradeRow,
  insertWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import {
  listOrgWorkspaces,
  listWorkspaceKnowledgeUnits,
} from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { readIngestSkillBundle } from "../ingestion/skill-bundle.js"
import { reingestUpgradeKey } from "../upgrades/reingest.js"
import { scanWorkspaceReingest } from "../upgrades/scan.js"
import { workspaceFormatFile } from "./workspace-format.js"

const TOOLS_SOURCE = {
  path: "sources/github/example/tools.md",
  body: "---\nprovider: github\nconnection: {{connectionId}}\nrepository: example/tools\n---\nThe tools repository.\n",
}

/**
 * A main-era org whose first Workspace is the fixture Workspace: the
 * repository `example/tools` has two objects in Postgres.
 */
async function withToolsKnowledge(
  f: NativeHydrationFixture,
  run: () => Promise<void>,
) {
  const repositoryId = `repo_tools_${f.id}`
  try {
    await withOrgDbContext(f.org.id, async (db) => {
      await db.insert(repositories).values({
        id: repositoryId,
        orgId: f.org.id,
        name: "tools",
        gitUrl: "https://github.com/example/tools.git",
      })
      await db.insert(orgFirstWorkspaces).values({
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        sourceRepositoryId: repositoryId,
      })
      await db.insert(objects).values([
        {
          id: `obj_tools_${f.id}`,
          orgId: f.org.id,
          kind: "Service",
          deduplicationKey: `svc:${repositoryId}:tools`,
          payload: { name: "Tools CLI", summary: "The release tools." },
        },
        {
          id: `obj_parser_${f.id}`,
          orgId: f.org.id,
          kind: "Library",
          deduplicationKey: `lib:${repositoryId}:parser`,
          payload: { name: "Parser", summary: "Reads the manifest." },
        },
      ])
    })
    await run()
  } finally {
    await withOrgDbContext(f.org.id, async (db) => {
      await db.delete(claims).where(eq(claims.orgId, f.org.id))
      await db.delete(objects).where(eq(objects.orgId, f.org.id))
    })
  }
}

/** The main-era units that the Workspace serves, by path. */
function legacyUnitPaths(f: NativeHydrationFixture) {
  return withOrgIdContext(f.org, async () =>
    (await listWorkspaceKnowledgeUnits(f.workspaceId)).units
      .filter((unit) => unit.source === "legacy")
      .map((unit) => unit.path)
      .sort(),
  )
}

const TOOLS_LEGACY_PATHS = [
  "knowledge/libraries/parser.md",
  "knowledge/services/tools-cli.md",
]

/** Project the current revision of the Workspace again. */
async function reproject(f: NativeHydrationFixture) {
  const run = await f.runner.runWorkflow(workspaceHydrate.spec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    revision: await f.resolveRevision(true),
    reproject: true,
  })
  return run.result({ timeoutMs: 60_000 })
}

/**
 * Upgrade step 1 does not export the main-era knowledge of a GitHub source
 * repository, because the re-ingestion makes it again. Until the
 * re-ingestion did that repository, hydrate serves the knowledge from
 * Postgres, so the merge of the upgrade leaves no gap.
 */
it(
  "serves the main-era knowledge of a source repository at format 3 until its re-ingestion is done",
  { timeout: 120_000 },
  async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    await withNativeHydrationFixture(
      {
        github: true,
        format: 3,
        files: [
          TOOLS_SOURCE,
          { path: "docs/readme.md", body: "# Readme\nThe Workspace.\n" },
        ],
      },
      (f) =>
        withToolsKnowledge(f, async () => {
          // After the upgrade merged and before the re-ingestion.
          await f.worker.start()
          expect(await f.handle.result({ timeoutMs: 60_000 })).toMatchObject({
            hydrated: true,
            units: f.count + 2,
          })
          expect(await legacyUnitPaths(f)).toEqual(TOOLS_LEGACY_PATHS)

          // The re-ingestion did the repository: hydrate projects again.
          await withOrgIdContext(f.org, () =>
            insertWorkspaceUpgradeRow({
              workspaceId: f.workspaceId,
              generation: 1,
              status: "completed",
              upgrade: {
                key: reingestUpgradeKey("ingest-test"),
                fromFormat: 3,
                targetFormat: 3,
                repositories: [
                  {
                    repository: "example/tools",
                    sha: f.sha,
                    runId: null,
                    status: "done",
                    report: [],
                  },
                ],
              },
            }),
          )
          expect(await reproject(f)).toMatchObject({
            hydrated: true,
            units: f.count,
          })
          expect(await legacyUnitPaths(f)).toEqual([])
          const units = await withOrgIdContext(f.org, () =>
            listWorkspaceKnowledgeUnits(f.workspaceId),
          )
          expect(units.units.map((unit) => unit.path).sort()).toEqual([
            "docs/readme.md",
            TOOLS_SOURCE.path,
          ])
        }),
    )
  },
)

/**
 * A new skill bundle makes the scan remove a `failed` re-ingestion row of
 * the old bundle. A repository that the failed run did stays done, so its
 * main-era knowledge does not come back.
 */
it(
  "keeps the main-era knowledge of a re-ingested repository gone after a skill bundle change",
  { timeout: 120_000 },
  async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        format: 3,
        files: [TOOLS_SOURCE],
      },
      (f) =>
        withToolsKnowledge(f, async () => {
          await f.worker.start()
          expect(await f.handle.result({ timeoutMs: 60_000 })).toMatchObject({
            hydrated: true,
          })
          expect(await legacyUnitPaths(f)).toEqual(TOOLS_LEGACY_PATHS)

          // A run of the old bundle did the repository, then failed.
          const oldKey = reingestUpgradeKey("ingest-old")
          await withOrgIdContext(f.org, () =>
            insertWorkspaceUpgradeRow({
              workspaceId: f.workspaceId,
              generation: 1,
              status: "failed",
              upgrade: {
                key: oldKey,
                fromFormat: 3,
                targetFormat: 3,
                repositories: [
                  {
                    repository: "example/tools",
                    sha: f.sha,
                    runId: null,
                    status: "done",
                    report: [],
                  },
                  {
                    repository: "example/other",
                    sha: f.sha,
                    runId: null,
                    status: "failed",
                    report: [],
                  },
                ],
              },
            }),
          )

          // The release has a new skill bundle: the scan replaces the row.
          const bundle = await readIngestSkillBundle()
          expect(bundle.name).not.toBe("ingest-old")
          await withOrgIdContext(f.org, async () => {
            const [workspace] = (await listOrgWorkspaces(f.org.id)).filter(
              (row) => row.id === f.workspaceId,
            )
            if (!workspace) throw new Error("The fixture Workspace is missing")
            expect(
              await scanWorkspaceReingest({
                orgId: f.org.id,
                workspace,
                bundle,
                format: 3,
                env: parseEnv(process.env),
              }),
            ).toMatchObject({ kind: "pending" })
            expect(
              await getWorkspaceUpgradeRow(f.workspaceId, oldKey),
            ).toBeNull()
          })

          expect(await reproject(f)).toMatchObject({ hydrated: true })
          expect(await legacyUnitPaths(f)).toEqual([])
        }),
    )
  },
)

/**
 * The operator reverts the upgrade pull request after the re-ingestion did a
 * repository. The revert deletes the files that upgrade step 1 wrote, and
 * the Workspace is below format 3 again.
 */
it(
  "shows each main-era item once after a revert of the upgrade pull request",
  { timeout: 120_000 },
  async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    await withNativeHydrationFixture(
      { github: true, format: 2, files: [TOOLS_SOURCE] },
      (f) =>
        withToolsKnowledge(f, async () => {
          // Knowledge of a repository that is not a source: step 1 writes
          // it to git.
          const docsId = `repo_docs_${f.id}`
          await withOrgDbContext(f.org.id, async (db) => {
            await db.insert(repositories).values({
              id: docsId,
              orgId: f.org.id,
              name: "docs",
              gitUrl: "https://gitlab.com/example/docs.git",
            })
            await db.insert(objects).values({
              id: `obj_handbook_${f.id}`,
              orgId: f.org.id,
              kind: "Service",
              deduplicationKey: `svc:${docsId}:handbook`,
              payload: { name: "Handbook", summary: "How the team works." },
            })
          })
          const handbook = "knowledge/services/handbook.md"
          await f.worker.start()
          expect(await f.handle.result({ timeoutMs: 60_000 })).toMatchObject({
            hydrated: true,
          })
          expect(await legacyUnitPaths(f)).toEqual(
            [handbook, ...TOOLS_LEGACY_PATHS].sort(),
          )

          const commit = (message: string, paths: string[]) => {
            f.git("add", "--", ...paths)
            f.git(
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.test",
              "commit",
              "-q",
              "-m",
              message,
            )
          }
          const push = () => f.git("push", "-q", f.remote, "HEAD:main")
          // The upgrade pull request: format 3, and the kept item in git.
          const format = workspaceFormatFile(3)
          await writeFile(join(f.directory, format.path), format.content)
          await mkdir(join(f.directory, "knowledge/services"), {
            recursive: true,
          })
          await writeFile(
            join(f.directory, handbook),
            "---\nkind: Service\nname: Handbook\n---\n# Handbook\n\nHow the team works.\n",
          )
          commit("Upgrade the Workspace to format 3", [format.path, handbook])
          const upgrade = f.git("rev-parse", "HEAD")
          // The re-ingestion did the tools repository.
          await writeFile(
            join(f.directory, "knowledge/services/tools.md"),
            "---\nkind: Service\nname: Tools\n---\n# Tools\n\nThe release tools.\n",
          )
          commit("Re-ingest example/tools", ["knowledge/services/tools.md"])
          await withOrgIdContext(f.org, () =>
            insertWorkspaceUpgradeRow({
              workspaceId: f.workspaceId,
              generation: 1,
              status: "completed",
              upgrade: {
                key: reingestUpgradeKey("ingest-test"),
                fromFormat: 3,
                targetFormat: 3,
                repositories: [
                  {
                    repository: "example/tools",
                    sha: f.sha,
                    runId: null,
                    status: "done",
                    report: [],
                  },
                ],
              },
            }),
          )
          // The operator reverts the upgrade pull request.
          f.git(
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "revert",
            "--no-edit",
            upgrade,
          )
          push()

          expect(await reproject(f)).toMatchObject({ hydrated: true })
          // The kept item comes back from Postgres, and the tools knowledge
          // is only the file of the re-ingestion.
          expect(await legacyUnitPaths(f)).toEqual([handbook])
          const paths = await withOrgIdContext(f.org, async () =>
            (await listWorkspaceKnowledgeUnits(f.workspaceId)).units.map(
              (unit) => unit.path,
            ),
          )
          expect(paths.filter((path) => path === handbook)).toHaveLength(1)
          expect(paths).toContain("knowledge/services/tools.md")
        }),
    )
  },
)
