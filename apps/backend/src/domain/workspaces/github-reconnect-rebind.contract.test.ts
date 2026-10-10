import { eq, sql } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  deleteGithubConnectionById,
  upsertInstallation,
} from "../../models/github-installation.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { rebindUnboundWorkspaces } from "./workspace-lifecycle.js"

it(
  "rebinds a workspace a GitHub disconnect detached when GitHub reconnects, and skips repositories outside the installation",
  { timeout: 45_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await f.handle.cancel()
      // GitHub refuses a token for a repository the installation does not cover.
      f.server.use(
        http.post(
          "https://api.github.com/app/installations/123456789/access_tokens",
          async ({ request }) => {
            const body = (await request.clone().json()) as {
              repositories?: string[]
            }
            if (body.repositories?.includes("outside-installation"))
              return HttpResponse.json(
                {
                  message:
                    "There is at least one repository that does not exist or is not accessible to the parent installation.",
                },
                { status: 422 },
              )
            // Other repositories fall through to the fixture's token handler.
            return undefined
          },
        ),
      )
      const outsideId = `${f.workspaceId}_outside`
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(workspaces).values({
          id: outsideId,
          orgId: f.org.id,
          slug: "outside",
          displayName: "Outside",
          workspaceRepositoryUrl:
            "https://github.com/fixture/outside-installation",
        }),
      )
      const errors: string[] = []
      const log = { error: (error: Error) => errors.push(error.message) }
      let reconnectedId: string | undefined
      try {
        expect(await deleteGithubConnectionById(f.org.id, f.connectionId)).toBe(
          true,
        )
        expect(
          await withOrgIdContext(f.org, () => getWorkspaceById(f.workspaceId)),
        ).toMatchObject({
          githubConnectionId: null,
          desiredGeneration: 2,
          hydrateStatus: "failed",
          hydrateError:
            "The GitHub connection was removed. Reconnect GitHub to restore this workspace.",
          writeStatus: "read_only",
        })

        const env = parseEnv(process.env)
        const sideJobRuns = async () => {
          const result = await getSystemDb().execute(sql`
            select workflow_name, count(*)::int as runs
            from openworkflow.workflow_runs
            where input->>'orgId' = ${f.org.id}
              and workflow_name in ('workspace-tip-check', 'workspace-write-bootstrap')
            group by workflow_name
          `)
          return new Map(
            result.rows.map((row) => [
              String(row.workflow_name),
              Number(row.runs),
            ]),
          )
        }
        const runsBefore = await sideJobRuns()
        const reconnected = await upsertInstallation(f.org.id, 123456789, env)
        reconnectedId = reconnected.id
        await rebindUnboundWorkspaces({
          orgId: f.org.id,
          connectionId: reconnected.id,
          env,
          log,
        })

        expect(
          await withOrgIdContext(f.org, () => getWorkspaceById(f.workspaceId)),
        ).toMatchObject({
          githubConnectionId: reconnected.id,
          desiredGeneration: 3,
          hydrateStatus: "pending",
          hydrateError: null,
        })
        await expect
          .poll(
            async () => {
              const result = await getSystemDb().execute(sql`
                select input->'revision'->'remote'->>'connectionId' as connection_id
                from openworkflow.workflow_runs
                where workflow_name = 'workspace-hydrate'
                  and input->>'workspaceId' = ${f.workspaceId}
                  and (input->'revision'->>'generation')::int = 3
              `)
              return result.rows.map((row) => row.connection_id)
            },
            { timeout: 10_000 },
          )
          .toEqual([reconnected.id])

        expect(
          await withOrgIdContext(f.org, () => getWorkspaceById(outsideId)),
        ).toMatchObject({ githubConnectionId: null, desiredGeneration: 1 })
        // The relink starts the tip check, the hydrate, and the bootstrap
        // without await, and they use the same log. The hydrate run is above.
        // Wait until the tip check starts a run and the bootstrap starts a
        // run or logs an error.
        await expect
          .poll(
            async () => {
              const runs = await sideJobRuns()
              const started = (name: string) =>
                (runs.get(name) ?? 0) > (runsBefore.get(name) ?? 0)
              return (
                started("workspace-tip-check") &&
                (started("workspace-write-bootstrap") || errors.length > 0)
              )
            },
            { timeout: 10_000 },
          )
          .toBe(true)
        expect(errors).toEqual([])
      } finally {
        await withOrgDbContext(f.org.id, async (db) => {
          await db.delete(workspaces).where(eq(workspaces.id, outsideId))
          if (reconnectedId)
            await db
              .delete(connections)
              .where(eq(connections.id, reconnectedId))
        })
      }
    })
  },
)

it(
  "admits the relink bootstrap when the tip moves during its write probe",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.handle.cancel()
        const tip = await withOrgIdContext(f.org, () =>
          getWorkspaceById(f.workspaceId),
        )
        if (!tip?.desiredSha) throw new Error("Fixture tip missing")
        // A relink starts the hydrate and the tip check beside the bootstrap.
        // They can store the remote tip while the bootstrap probes GitHub.
        let moved = false
        f.onWriteProbe(async () => {
          if (moved) return
          moved = true
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(workspaces)
              .set({ desiredSha: null })
              .where(eq(workspaces.id, f.workspaceId)),
          )
        })
        const errors: string[] = []
        const admitted = await withOrgIdContext(f.org, () =>
          enqueueWriteJob(
            { orgId: f.org.id, workspaceId: f.workspaceId, kind: "bootstrap" },
            { error: (error) => errors.push(error.message) },
          ),
        )

        expect(errors).toEqual([])
        expect(moved).toBe(true)
        expect(admitted).toEqual({ started: true })
        const result = await getSystemDb().execute(sql`
          select count(*)::int as runs from openworkflow.workflow_runs
          where workflow_name = 'workspace-write-bootstrap'
            and input->>'workspaceId' = ${f.workspaceId}
        `)
        expect(result.rows[0]?.runs).toBe(1)
      },
    )
  },
)

it(
  "refuses a write that is not a bootstrap when the tip moves during its write probe",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.handle.cancel()
        let moved = false
        f.onWriteProbe(async () => {
          if (moved) return
          moved = true
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(workspaces)
              .set({ desiredSha: null })
              .where(eq(workspaces.id, f.workspaceId)),
          )
        })
        const errors: string[] = []
        const admitted = await withOrgIdContext(f.org, () =>
          enqueueWriteJob(
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              kind: "claims_upgrade",
            },
            { error: (error) => errors.push(error.message) },
          ),
        )

        expect(moved).toBe(true)
        expect(admitted).toEqual({ started: false })
        expect(errors).toEqual(["Workspace write binding is unavailable"])
      },
    )
  },
)

it(
  "admits the relink bootstrap when the tip moves after its write status is stored",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        await f.handle.cancel()
        const tip = await withOrgIdContext(f.org, () =>
          getWorkspaceById(f.workspaceId),
        )
        if (!tip?.desiredSha) throw new Error("Fixture tip missing")
        const movedSha = "f".repeat(40)
        const { default: postgres } = await import("postgres")
        const ownerUrl = new URL(process.env.DATABASE_URL ?? "")
        ownerUrl.username = "ctxpipe"
        const owner = postgres(ownerUrl.toString(), { max: 1 })
        const fixtureName = `fixture_tip_move_${Date.now()}`
        try {
          // This disposable trigger moves the tip in the same statement that
          // stores the write status. Thus the tip moves after the
          // compare-and-set and before admission resolves the revision.
          await owner.unsafe(
            `CREATE FUNCTION public.${fixtureName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.desired_sha := '${movedSha}'; RETURN NEW; END; $$`,
          )
          await owner.unsafe(
            `CREATE TRIGGER ${fixtureName} BEFORE UPDATE ON public.workspaces FOR EACH ROW WHEN (NEW.id = '${f.workspaceId}' AND OLD.desired_sha = '${tip.desiredSha}' AND NEW.desired_sha IS NOT DISTINCT FROM OLD.desired_sha) EXECUTE FUNCTION public.${fixtureName}()`,
          )
          const errors: string[] = []
          const admitted = await withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                kind: "bootstrap",
              },
              { error: (error) => errors.push(error.message) },
            ),
          )

          expect(errors).toEqual([])
          expect(admitted).toEqual({ started: true })
          const result = await getSystemDb().execute(sql`
            select input->'revision'->>'sha' as sha
            from openworkflow.workflow_runs
            where workflow_name = 'workspace-write-bootstrap'
              and input->>'workspaceId' = ${f.workspaceId}
          `)
          expect(result.rows).toEqual([{ sha: movedSha }])
        } finally {
          await owner.unsafe(
            `DROP TRIGGER IF EXISTS ${fixtureName} ON public.workspaces`,
          )
          await owner.unsafe(`DROP FUNCTION IF EXISTS public.${fixtureName}()`)
          await owner.end()
        }
      },
    )
  },
)
