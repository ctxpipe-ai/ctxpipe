import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  getWorkspaceById,
  getWorkspaceWriteAdmission,
  listWorkspaceKnowledgeUnits,
} from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { workspaceRoutes } from "../../routes/v1/workspaces.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { SOURCES_FILE_PATH } from "../workspace-sources/sources-file.js"
import {
  CODE_FORMAT,
  WORKSPACE_FORMAT_INVALID,
  WORKSPACE_FORMAT_PATH,
} from "./workspace-format.js"
import { WRITE_STATUS_REASONS } from "./write-status.js"

const unit = { path: "knowledge/a.md", body: "# A\nCommitted body.\n" }

// ctx| content from before Workspaces: the sources file of format 1.
const legacySources = {
  path: SOURCES_FILE_PATH,
  body: "version: 1\nsources: []\n",
}

it.each([
  {
    name: "no format file",
    file: null,
    extra: [legacySources],
    format: 0,
    reason: null,
  },
  // A repository with no ctx| content gets its format file from the
  // bootstrap commit. Until then the format is not known: 0 would ask for an
  // upgrade that the repository does not need.
  {
    name: "no format file and no ctx| content as not known",
    file: null,
    format: null,
    reason: null,
  },
  {
    name: "the code format",
    file: `format: ${CODE_FORMAT}\n`,
    format: CODE_FORMAT,
    reason: null,
  },
  {
    name: "a newer format",
    file: `format: ${CODE_FORMAT + 1}\n`,
    format: CODE_FORMAT + 1,
    reason: WRITE_STATUS_REASONS.formatAhead,
  },
  {
    name: "a format file that is not valid",
    file: "format: [3\n",
    format: WORKSPACE_FORMAT_INVALID,
    reason: WRITE_STATUS_REASONS.formatInvalid,
  },
])(
  "hydrate caches $name from git and gates writes, and a rebuilt database reads it again",
  { timeout: 90_000 },
  async ({ file, extra = [], format, reason }) =>
    withNativeHydrationFixture(
      {
        writeStatus: "writable",
        files: [
          unit,
          ...extra,
          ...(file ? [{ path: WORKSPACE_FORMAT_PATH, body: file }] : []),
        ],
      },
      async (f) => {
        await f.worker.start()
        expect(await f.handle.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: true,
          units: 1,
        })
        const check = async () =>
          withOrgIdContext(f.org, async () => {
            const workspace = await getWorkspaceById(f.workspaceId)
            expect(workspace?.formatVersion).toBe(format)
            // Reads are served at every format.
            expect(
              (await listWorkspaceKnowledgeUnits(f.workspaceId)).units.map(
                (row) => row.path,
              ),
            ).toEqual([unit.path])
            // The write admission of every broker write path has the gate.
            expect(
              await getWorkspaceWriteAdmission(f.workspaceId),
            ).toMatchObject(
              reason
                ? { writeStatus: "read_only", readOnlyReason: reason }
                : { writeStatus: "writable", readOnlyReason: null },
            )
            const response = await workspaceHttpApp(
              f.org,
              workspaceRoutes,
            ).request("/workspaces/knowledge")
            expect(await response.json()).toMatchObject({
              writeStatus: reason ? "read_only" : "writable",
              readOnlyReason: reason,
              conversationWritable: !reason,
            })
          })
        // The stored probe result does not change: the gate is a read.
        const [stored] = await withOrgDbContext(f.org.id, (db) =>
          db
            .select({ writeStatus: workspaces.writeStatus })
            .from(workspaces)
            .where(eq(workspaces.id, f.workspaceId)),
        )
        expect(stored?.writeStatus).toBe("writable")
        await check()

        // A rebuilt database has no projection and no cache. Hydrate reads
        // the same value from git again.
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({
              formatVersion: null,
              activeRevision: null,
              activeProjectionSha: null,
              activeProjectionUrl: null,
              hydratePhases: null,
            })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        const again = await f.runner.runWorkflow(workspaceHydrate.spec, {
          orgId: f.org.id,
          workspaceId: f.workspaceId,
          revision: f.revision,
        })
        expect(await again.result({ timeoutMs: 30_000 })).toMatchObject({
          hydrated: true,
        })
        await check()
      },
    ),
)
