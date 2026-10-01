import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { getGithubPrMirrorBinding } from "../../models/github-pr-mirror.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { githubSyncPullRequest } from "../../openworkflow/workflows/github-sync-pull-request.js"
import { workspaceConnectorMirror } from "../../openworkflow/workflows/workspace-connector-mirror.js"
import { prepareGithubPrMirrorConfigYaml } from "../../services/github/pull-request-mirror/sync.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

const GITHUB_PR_CONFIG = `version: 1
source: github
pullRequests:
  repositories:
    - fixture/hydration-contract
  states:
    - merged
  includeDrafts: false
  maxPullRequestsPerRepository: 200
`

const MERGED_PULL = {
  number: 7,
  id: 70,
  html_url: "https://github.com/fixture/hydration-contract/pull/7",
  title: "Ship the fence",
  body: "",
  state: "closed",
  merged: true,
  draft: false,
  user: { login: "alice", type: "User" },
  base: { ref: "main", sha: "a".repeat(40) },
  head: { ref: "feature", sha: "b".repeat(40) },
  created_at: "2026-03-01T00:00:00.000Z",
  updated_at: "2026-03-02T00:00:00.000Z",
  merged_at: "2026-03-02T00:00:00.000Z",
}

it.each([
  "entity",
  "policy",
  "no_workspace",
  "read_only",
  "config_yaml",
] as const)(
  "publishes GitHub pull-request %s through workspace capture and the native mirror child",
  { timeout: 45_000 },
  async (mode) => {
    await withNativeHydrationFixture(
      {
        namespaceId: "default",
        github: true,
        githubWriteView: mode === "read_only" ? "missing" : "writable",
        writeStatus: mode === "read_only" ? "read_only" : "writable",
        githubContentFiles: { "github/config.yaml": GITHUB_PR_CONFIG },
        githubPullRequest: MERGED_PULL,
        files: [
          { path: "github/config.yaml", body: GITHUB_PR_CONFIG },
          { path: "knowledge/owner.md", body: "# Owner text\n" },
        ],
      },
      async (f) => {
        await f.runner.cancelWorkflowRun(f.handle.workflowRun.id)
        const workspaceRepo = await withOrgIdContext(f.org, () =>
          ensureOrgRepositoryForGitUrl({
            orgId: f.org.id,
            gitUrl: f.workspaceUrl,
            githubConnectionId: f.connectionId,
          }),
        )
        if (!workspaceRepo) throw new Error("Fixture repository missing")
        const destRepo =
          mode === "no_workspace"
            ? await withOrgIdContext(f.org, () =>
                ensureOrgRepositoryForGitUrl({
                  orgId: f.org.id,
                  gitUrl: "https://github.com/fixture/unbound-dest.git",
                  githubConnectionId: f.connectionId,
                }),
              )
            : workspaceRepo
        if (!destRepo) throw new Error("Dest repository missing")
        await withOrgDbContext(f.org.id, (db) =>
          db
            .update(connections)
            .set({
              config: {
                installationId: 123456789,
                ingestAllRepositories: false,
                includeFutureRepos: false,
                prMirror: {
                  repositoryId: destRepo.id,
                  branch: "main",
                  enabled: true,
                  setupPhase: mode === "config_yaml" ? "draft" : "live",
                },
              },
            })
            .where(eq(connections.id, f.connectionId)),
        )
        f.runner.implementWorkflow(
          githubSyncPullRequest.spec,
          githubSyncPullRequest.fn,
        )
        f.runner.implementWorkflow(
          workspaceConnectorMirror.spec,
          workspaceConnectorMirror.fn,
        )
        const worker = f.runner.newWorker({ concurrency: 1 })
        try {
          await worker.start()
          if (mode === "config_yaml") {
            const handle = await f.runner.runWorkflow(
              workspaceConnectorMirror.spec,
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                jobId: `wjob_${f.id}_ghcfg`,
                revision: { ...f.revision, access: "write-default" },
                mirror: {
                  provider: "github",
                  connectionId: f.connectionId,
                  repositoryId: workspaceRepo.id,
                  configBlobSha: f.git(
                    "--git-dir",
                    f.remote,
                    "rev-parse",
                    `${f.sha}:github/config.yaml`,
                  ),
                },
                files: [
                  {
                    path: "github/config.yaml",
                    content: GITHUB_PR_CONFIG.replace(
                      "fixture/hydration-contract",
                      "fixture/api",
                    ),
                  },
                ],
                deletePaths: [],
              },
            )
            await expect(handle.result({ timeoutMs: 20_000 })).resolves.toEqual(
              {
                committed: true,
                commitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
              },
            )
            expect(
              f.git("--git-dir", f.remote, "show", "main:github/config.yaml"),
            ).toContain("fixture/api")
            return
          }
          if (mode === "no_workspace") {
            const binding = await getGithubPrMirrorBinding(
              f.org.id,
              f.connectionId,
            )
            if (!binding) throw new Error("Expected GitHub PR mirror binding")
            await expect(
              prepareGithubPrMirrorConfigYaml({
                orgId: f.org.id,
                env: parseEnv(process.env),
                binding,
                repositories: ["fixture/api"],
              }),
            ).rejects.toThrow(/Connector target has no Workspace/)
            expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
              f.sha,
            )
            return
          }

          const handle = await f.runner.runWorkflow(
            githubSyncPullRequest.spec,
            {
              orgId: f.org.id,
              connectionId: f.connectionId,
              sourceRepository:
                mode === "policy"
                  ? "fixture/docs-only"
                  : "fixture/hydration-contract",
              number: 7,
            },
          )
          if (mode === "read_only") {
            await expect
              .poll(
                () =>
                  withOrgIdContext(f.org, () =>
                    reconcileWorkspaceWriteJob(
                      `wjob_${handle.workflowRun.id}_mirror`,
                    ),
                  ),
                { timeout: 20_000 },
              )
              .toMatchObject({ status: "paused" })
            expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(
              f.sha,
            )
            return
          }
          const result = await handle.result({ timeoutMs: 20_000 })
          if (mode === "policy") {
            expect(result).toEqual({ written: false, skipped: "policy" })
            expect(
              (await f.backend.listWorkflowRuns({ limit: 100 })).data.filter(
                (run) =>
                  run.workflowName === "workspace-write-connector-mirror",
              ),
            ).toHaveLength(0)
            return
          }
          expect(result).toEqual({
            written: true,
            path: "github/pulls/fixture/hydration-contract/7--70.md",
          })
          const children = (
            await f.backend.listWorkflowRuns({ limit: 100 })
          ).data.filter(
            (run) => run.workflowName === "workspace-write-connector-mirror",
          )
          expect(children).toHaveLength(1)
          expect(children[0]).toMatchObject({
            status: "completed",
            input: {
              mirror: {
                provider: "github",
                connectionId: f.connectionId,
                repositoryId: workspaceRepo.id,
              },
            },
          })
          expect(
            (await f.backend.listWorkflowRuns({ limit: 100 })).data.some(
              (run) => run.workflowName === "repository-ingestion-orchestrator",
            ),
          ).toBe(true)
          expect(
            f.git(
              "--git-dir",
              f.remote,
              "ls-tree",
              "-r",
              "--name-only",
              "main",
            ),
          ).toContain("github/pulls/fixture/hydration-contract/7--70.md")
        } finally {
          for (const run of (await f.backend.listWorkflowRuns({ limit: 100 }))
            .data) {
            if (!["completed", "failed", "canceled"].includes(run.status))
              await f.runner.cancelWorkflowRun(run.id)
          }
          await worker.stop()
        }
      },
    )
  },
)
