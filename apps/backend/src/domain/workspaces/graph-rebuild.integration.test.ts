import { createHash } from "node:crypto"
import { symlinkSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { getWorkspaceProjection } from "../../models/workspaces.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { getGraphClient, withGraphClient } from "../../platform/graph/client.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import {
  hasWorkspaceGraph,
  workspaceGraphRevisionKey,
} from "./graph-projection.js"
import {
  readOrRebuildWorkspaceGraph,
  WorkspaceGraphBuildingError,
} from "./graph-rebuild.js"
import { publishedProjection, workspaceRevisionSchema } from "./revision.js"

it(
  "starts a new projection when the graph store holds only a version 2 graph",
  { timeout: 90_000 },
  async () => {
    await withNativeHydrationFixture({}, async (f) => {
      await f.publish()
      const id = `ws_v2_${f.id}`
      const remote = join(f.directory, "v2.git")
      symlinkSync(f.remote, remote)
      const revision = {
        ...f.revision,
        workspaceId: id,
        remote: { url: remote, connectionId: null },
      }
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(workspaces).values({
          id,
          orgId: f.org.id,
          slug: "v2",
          displayName: "V2",
          workspaceRepositoryUrl: remote,
          desiredSha: f.sha,
          desiredDefaultBranch: "main",
          activeRevision: revision,
          activeProjectionUrl: remote,
          activeProjectionSha: f.sha,
          indexedSha: f.sha,
          hydrateStatus: "ready",
          writeStatus: "read_only",
          hydratePhases: {
            url: remote,
            sha: f.sha,
            revision,
            embeddings: true,
            graph: { revision, result: { kind: "ready" as const } },
            index: { revision, result: { kind: "ready" as const } },
          },
        }),
      )
      const queue = await BackendPostgres.connect(f.databaseUrl, {
        runMigrations: false,
        namespaceId: openWorkflowNamespaceId(),
      })
      try {
        const org = { orgId: f.org.id, orgSlug: f.org.slug }
        // Version 2 stored validity bounds without UTC normalization.
        const legacyKey = createHash("sha256")
          .update(
            JSON.stringify({
              projectionVersion: 2,
              revision: workspaceRevisionSchema.parse(revision),
            }),
          )
          .digest("hex")
        expect(workspaceGraphRevisionKey(revision)).not.toBe(legacyKey)
        await withGraphClient(org, () =>
          getGraphClient().executeQuery(
            "CREATE (:WorkspaceProjection {projectionKey: $key, nodeCount: 0, claimCount: 0, completedAt: '2026-01-01T00:00:00.000Z'})",
            { key: legacyKey },
          ),
        )
        const projection = publishedProjection(
          await withOrgIdContext({ id: f.org.id, slug: f.org.slug }, () =>
            getWorkspaceProjection(id),
          ),
        )
        await expect(
          readOrRebuildWorkspaceGraph({ ...org, projection }),
        ).rejects.toBeInstanceOf(WorkspaceGraphBuildingError)
        const runs = (
          await queue.listWorkflowRuns({ limit: 1000 })
        ).data.filter(
          (run) =>
            run.workflowName === "workspace-hydrate" &&
            (run.input as { workspaceId?: string }).workspaceId === id,
        )
        expect(runs).toHaveLength(1)
      } finally {
        await queue.stop()
        await withOrgDbContext(f.org.id, (db) =>
          db.delete(workspaces).where(eq(workspaces.id, id)),
        )
      }
    })
  },
)

it(
  "counts a marker without its counts or time as a missing graph",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture({}, async (f) => {
      const org = { orgId: f.org.id, orgSlug: f.org.slug }
      const revision = { ...f.revision, workspaceId: `ws_marker_${f.id}` }
      await withGraphClient(org, () =>
        getGraphClient().executeQuery(
          "CREATE (:WorkspaceProjection {projectionKey: $key})",
          { key: workspaceGraphRevisionKey(revision) },
        ),
      )
      expect(await hasWorkspaceGraph({ ...org, revision })).toBe(false)
      await withGraphClient(org, () =>
        getGraphClient().executeQuery(
          "MATCH (p:WorkspaceProjection {projectionKey: $key}) SET p.nodeCount = 0, p.claimCount = 0, p.completedAt = '2026-01-01T00:00:00.000Z'",
          { key: workspaceGraphRevisionKey(revision) },
        ),
      )
      expect(await hasWorkspaceGraph({ ...org, revision })).toBe(true)
    })
  },
)
