import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { claims } from "../../db/schema/claims.js"
import { objects } from "../../db/schema/objects.js"
import { repositories } from "../../db/schema/repositories.js"
import { orgFirstWorkspaces } from "../../db/schema/workspaces.js"
import { insertWorkspaceUpgradeRow } from "../../models/workspace-upgrades.js"
import { listWorkspaceKnowledgeUnits } from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { reingestUpgradeKey } from "../upgrades/reingest.js"

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
          {
            path: "sources/github/example/tools.md",
            body: "---\nprovider: github\nconnection: {{connectionId}}\nrepository: example/tools\n---\nThe tools repository.\n",
          },
          { path: "docs/readme.md", body: "# Readme\nThe Workspace.\n" },
        ],
      },
      async (f) => {
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
          const units = () =>
            withOrgIdContext(f.org, async () =>
              (await listWorkspaceKnowledgeUnits(f.workspaceId)).units.map(
                (unit) => ({ path: unit.path, source: unit.source }),
              ),
            )

          // After the upgrade merged and before the re-ingestion.
          await f.worker.start()
          expect(await f.handle.result({ timeoutMs: 60_000 })).toMatchObject({
            hydrated: true,
            units: f.count + 2,
          })
          const before = await units()
          expect(
            before
              .filter((unit) => unit.source === "legacy")
              .map((u) => u.path),
          ).toEqual([
            expect.stringMatching(/^knowledge\/libraries\/parser\.md$/),
            expect.stringMatching(/^knowledge\/services\/tools-cli\.md$/),
          ])

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
          const again = await f.runner.runWorkflow(workspaceHydrate.spec, {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            revision: await f.resolveRevision(),
            reproject: true,
          })
          expect(await again.result({ timeoutMs: 60_000 })).toMatchObject({
            hydrated: true,
            units: f.count,
          })
          const after = await units()
          expect(after.filter((unit) => unit.source === "legacy")).toEqual([])
          expect(after.map((unit) => unit.path).sort()).toEqual([
            "docs/readme.md",
            "sources/github/example/tools.md",
          ])
        } finally {
          await withOrgDbContext(f.org.id, async (db) => {
            await db.delete(claims).where(eq(claims.orgId, f.org.id))
            await db.delete(objects).where(eq(objects.orgId, f.org.id))
          })
        }
      },
    )
  },
)
