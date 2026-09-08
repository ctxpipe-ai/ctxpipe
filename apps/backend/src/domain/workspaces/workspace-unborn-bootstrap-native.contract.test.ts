import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { OpenWorkflow } from "openworkflow"
import { BackendPostgres } from "openworkflow/postgres"
import { expect, it } from "vitest"
import { withUserIdContext } from "../../auth/context.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import {
  getWorkspaceById,
  listWorkspaceKnowledgeUnits,
} from "../../models/workspaces.js"
import { enqueueWorkspaceHydrate } from "../../openworkflow/enqueue-workspace-hydrate.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { workspaceBootstrap } from "../../openworkflow/workflows/workspace-bootstrap.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { createWorkspaceLifecycle } from "./workspace-lifecycle.js"

it.each([
  "empty",
  "select-existing",
  "first writer",
  "satisfied first writer",
  "read-only",
  "relink",
  "default changed",
] as const)(
  "bootstraps an unborn default branch after %s admission",
  { timeout: 45_000 },
  async (mode) => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        githubDefaultBranch: () => "trunk",
      },
      async (f) => {
        await f.handle.cancel()
        rmSync(f.remote, { recursive: true, force: true })
        f.git("init", "--bare", "--initial-branch=trunk", f.remote)
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(workspaces)
            .set({
              desiredSha: null,
              desiredDefaultBranch: null,
              indexedSha: null,
            })
            .where(eq(workspaces.id, f.workspaceId)),
        )
        if (mode === "select-existing") {
          const canonicalUrl = f.workspaceUrl.replace(/\.git$/, "")
          f.git(
            "config",
            "--global",
            "--add",
            `url.${f.remote}.insteadOf`,
            canonicalUrl,
          )
          await withOrgDbContext(f.org.id, (db) =>
            db
              .update(workspaces)
              .set({ workspaceRepositoryUrl: canonicalUrl })
              .where(eq(workspaces.id, f.workspaceId)),
          )
        }
        expect(f.git("ls-remote", "--heads", f.remote)).toBe("")
        const jobId = `wjob_${f.id}_unborn`
        const errors: string[] = []
        await withOrgIdContext(f.org, () =>
          enqueueWorkspaceHydrate(
            { orgId: f.org.id, workspaceId: f.workspaceId },
            { error: (error) => errors.push(error.message) },
          ),
        )
        expect(errors).toEqual([])
        await withOrgIdContext(f.org, async () => {
          const empty = await getWorkspaceById(f.workspaceId)
          expect(empty?.desiredSha).toBeNull()
          expect(empty?.activeProjectionSha).toBeNull()
          expect(empty?.hydrateStatus).not.toBe("failed")
          expect(
            (await listWorkspaceKnowledgeUnits(f.workspaceId)).units,
          ).toEqual([])
        })
        expect(f.git("ls-remote", "--heads", f.remote)).toBe("")
        const admit = () =>
          withOrgIdContext(f.org, () =>
            enqueueWriteJob(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                jobId,
                kind: "bootstrap",
              },
              { error: (error) => errors.push(error.message) },
            ),
          )
        if (mode === "select-existing") {
          await withOrgIdContext(f.org, () =>
            withUserIdContext("unborn-select-proof", () =>
              createWorkspaceLifecycle({
                orgId: f.org.id,
                gitUrl: f.workspaceUrl,
                githubConnectionId: f.connectionId,
                source: "select",
                log: { error: (error) => errors.push(error.message) },
              }),
            ),
          )
        } else {
          expect(await admit()).toEqual({ started: true })
          expect(errors).toEqual([])
        }
        if (mode === "first writer" || mode === "satisfied first writer") {
          let initialized = false
          f.onWriteCredentialRequest(async () => {
            if (initialized) return
            initialized = true
            const human = join(f.directory, "human-root")
            mkdirSync(human)
            f.git("init", "--initial-branch=trunk", human)
            writeFileSync(join(human, "README.md"), "# Human first commit\n")
            if (mode === "satisfied first writer") {
              writeFileSync(
                join(human, "AGENTS.md"),
                "---\nname: Hydration contract\n---\n\n<!-- ctxpipe:folder-map -->\n## Folder Structure\n\nUse knowledge/ and repositories/.\n<!-- /ctxpipe:folder-map -->\n",
              )
              mkdirSync(join(human, ".agents/skills/ctxpipe-knowledge"), {
                recursive: true,
              })
              writeFileSync(
                join(human, ".agents/skills/ctxpipe-knowledge/SKILL.md"),
                "---\nname: ctxpipe-knowledge\n---\n\nWrite knowledge/ files with confidence 0.5 or 0.7. Avoid obj_ jargon.\n",
              )
            }
            f.git("-C", human, "add", ".")
            f.git(
              "-C",
              human,
              "-c",
              "user.name=Human",
              "-c",
              "user.email=human@example.test",
              "commit",
              "-m",
              "Human initialized repository",
            )
            f.git("-C", human, "push", f.remote, "HEAD:refs/heads/trunk")
          })
        }
        if (["read-only", "relink", "default changed"].includes(mode)) {
          f.onWriteCredentialRequest(async () => {
            if (mode === "default changed") {
              f.git(
                "--git-dir",
                f.remote,
                "symbolic-ref",
                "HEAD",
                "refs/heads/new-default",
              )
              return
            }
            await withOrgDbContext(f.org.id, (db) =>
              db
                .update(workspaces)
                .set(
                  mode === "relink"
                    ? { desiredGeneration: 2 }
                    : {
                        writeStatus: "read_only",
                        readOnlyReason: "contents_write_denied",
                      },
                )
                .where(eq(workspaces.id, f.workspaceId)),
            )
          })
        }
        const backend = await BackendPostgres.connect(f.databaseUrl, {
          runMigrations: false,
        })
        const runner = new OpenWorkflow({ backend })
        runner.implementWorkflow(workspaceBootstrap.spec, workspaceBootstrap.fn)
        const worker = runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          if (["read-only", "relink", "default changed"].includes(mode)) {
            await expect
              .poll(
                () =>
                  withOrgIdContext(
                    f.org,
                    async () =>
                      (await reconcileWorkspaceWriteJob(jobId))?.status,
                  ),
                { timeout: 25_000 },
              )
              .toBe(mode === "read-only" ? "paused" : "failed")
            expect(f.git("ls-remote", "--heads", f.remote)).toBe("")
            return
          }
          if (mode === "select-existing") {
            await expect
              .poll(() => f.git("ls-remote", "--heads", f.remote), {
                timeout: 15_000,
              })
              .toContain("refs/heads/trunk")
            expect(
              f.git("--git-dir", f.remote, "rev-list", "--count", "trunk"),
            ).toBe("1")
            expect(
              f.git("--git-dir", f.remote, "show", "trunk:AGENTS.md"),
            ).toContain("name: Hydration contract")
            return
          }
          await expect
            .poll(
              () =>
                withOrgIdContext(
                  f.org,
                  async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
                ),
              { timeout: 25_000 },
            )
            .toBe("completed")
          const tip = f.git("--git-dir", f.remote, "rev-parse", "trunk")
          if (mode === "empty")
            expect(
              f.git("--git-dir", f.remote, "log", "-1", "--format=%s", "trunk"),
            ).toBe("ctxpipe - Bootstrap workspace knowledge")
          if (mode === "satisfied first writer") {
            const replay = await runner.runWorkflow(workspaceBootstrap.spec, {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId,
              bootstrapBinding: {
                workspaceId: f.workspaceId,
                generation: 1,
                remote: f.revision.remote,
                defaultBranch: "trunk",
              },
            })
            expect(await replay.result({ timeoutMs: 15_000 })).toEqual({
              committed: false,
              reason: "no_changes",
            })
            expect(
              f.git("--git-dir", f.remote, "rev-list", "--count", "trunk"),
            ).toBe("1")
            expect(
              f.git("--git-dir", f.remote, "show", "trunk:README.md"),
            ).toBe("# Human first commit")
            return
          }
          expect(
            f.git("--git-dir", f.remote, "rev-list", "--count", "trunk"),
          ).toBe(mode === "first writer" ? "2" : "1")
          expect(
            f.git("--git-dir", f.remote, "show", "trunk:AGENTS.md"),
          ).toContain("name: Hydration contract")
          const paths = f
            .git("--git-dir", f.remote, "ls-tree", "-r", "--name-only", "trunk")
            .split("\n")
          expect(paths).toContain(".agents/skills/ctxpipe-knowledge/SKILL.md")
          expect(
            paths.every(
              (path) =>
                (mode === "first writer" && path === "README.md") ||
                path === "AGENTS.md" ||
                path.startsWith(".agents/skills/ctxpipe-knowledge/"),
            ),
          ).toBe(true)
          if (mode === "first writer")
            expect(
              f.git("--git-dir", f.remote, "show", "trunk:README.md"),
            ).toBe("# Human first commit")
          expect(await admit()).toEqual({ started: true })
          expect(
            (
              await withOrgIdContext(f.org, () =>
                reconcileWorkspaceWriteJob(jobId),
              )
            )?.commitSha,
          ).toBe(tip)
          expect(
            f.git("--git-dir", f.remote, "rev-list", "--count", "trunk"),
          ).toBe(mode === "first writer" ? "2" : "1")
        } finally {
          await worker.stop()
          await backend.stop()
        }
      },
    )
  },
)
