import { expect, it } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { reconcileWorkspaceWriteJob } from "../../models/workspace-write-jobs.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { dryRunGithubMirrorCleanup } from "./github-mirror-cleanup.js"

const source = {
  path: "sources/github/acme/billing.md",
  body: '---\nprovider: github\nconnection: "{{connectionId}}"\nrepository: acme/billing\n---\n',
}
const note = { path: "knowledge/notes.md", body: "# Notes\n" }
const mirror = (path: string) => ({ path, body: `# ${path}\n` })

/** Run the cleanup job on the fixture until the job is done. */
async function runCleanup(f: NativeHydrationFixture, jobId: string) {
  const { BackendPostgres } = await import("openworkflow/postgres")
  const { OpenWorkflow } = await import("openworkflow")
  const { workspaceGithubMirrorCleanup } =
    await import("../../openworkflow/workflows/workspace-github-mirror-cleanup.js")
  const backend = await BackendPostgres.connect(f.databaseUrl, {
    namespaceId: openWorkflowNamespaceId(),
    runMigrations: false,
  })
  const runner = new OpenWorkflow({ backend })
  runner.implementWorkflow(
    workspaceGithubMirrorCleanup.spec,
    workspaceGithubMirrorCleanup.fn,
  )
  const worker = runner.newWorker({ concurrency: 1 })
  await worker.start()
  try {
    expect(
      await withOrgIdContext(f.org, () =>
        enqueueWriteJob(
          {
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            jobId,
            kind: "github_mirror_cleanup",
          },
          { error: () => {} },
        ),
      ),
    ).toEqual({ started: true })
    await expect
      .poll(
        () =>
          withOrgIdContext(
            f.org,
            async () => (await reconcileWorkspaceWriteJob(jobId))?.status,
          ),
        { timeout: 30_000 },
      )
      .toBe("completed")
  } finally {
    await worker.stop()
    await backend.stop()
  }
}

const dryRun = (f: NativeHydrationFixture) =>
  withOrgIdContext(f.org, () =>
    dryRunGithubMirrorCleanup({
      orgId: f.org.id,
      workspaceId: f.workspaceId,
      env: parseEnv(process.env),
    }),
  )

const mainSha = (f: NativeHydrationFixture) =>
  f.git("--git-dir", f.remote, "rev-parse", "refs/heads/main")

const treeFiles = (f: NativeHydrationFixture) =>
  f
    .git(
      "--git-dir",
      f.remote,
      "ls-tree",
      "-r",
      "--name-only",
      "refs/heads/main",
    )
    .split("\n")
    .filter(Boolean)
    .sort()

const fixture = (files: Array<{ path: string; body: string }>) => ({
  github: true,
  githubWriteView: "writable" as const,
  writeStatus: "writable" as const,
  files,
})

it(
  "deletes duplicates, moves mixed-case files, and deletes the mirrors of removed sources, in one commit",
  { timeout: 60_000 },
  async () => {
    const moved = mirror("github/pulls/Acme/Billing/2--12.md")
    await withNativeHydrationFixture(
      fixture([
        source,
        note,
        // The lowercase copy stays; its mixed-case copy is a duplicate.
        mirror("github/pulls/acme/billing/1--11.md"),
        mirror("github/pulls/Acme/Billing/1--11.md"),
        // No lowercase copy: the file moves.
        moved,
        mirror("github/issues/ACME/billing/3.md"),
        // No source holds this repository.
        mirror("github/pulls/acme/gone/4--14.md"),
        mirror("github/issues/Acme/Gone/5.md"),
      ]),
      async (f) => {
        const before = treeFiles(f)
        expect(await dryRun(f)).toEqual({
          duplicates: 1,
          moves: 2,
          removedSourceFolders: 2,
          removedSourceFiles: 2,
          skipped: 0,
        })
        // The dry run writes nothing.
        expect(mainSha(f)).toBe(f.sha)

        await runCleanup(f, `wjob_${f.id}_mirror_cleanup`)
        expect(
          f.git(
            "--git-dir",
            f.remote,
            "rev-list",
            "--count",
            `${f.sha}..refs/heads/main`,
          ),
        ).toBe("1")
        const after = treeFiles(f)
        expect(after.filter((path) => path.startsWith("github/"))).toEqual([
          "github/issues/acme/billing/3.md",
          "github/pulls/acme/billing/1--11.md",
          "github/pulls/acme/billing/2--12.md",
        ])
        // The cleanup changes nothing outside the mirror folders.
        expect(after.filter((path) => !path.startsWith("github/"))).toEqual(
          before.filter((path) => !path.startsWith("github/")),
        )
        expect(
          f.git(
            "--git-dir",
            f.remote,
            "show",
            "refs/heads/main:github/pulls/acme/billing/2--12.md",
          ),
        ).toBe(moved.body.trimEnd())
      },
    )
  },
)

it(
  "makes no commit for a Workspace with nothing to clean up",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      fixture([source, note, mirror("github/pulls/acme/billing/1--11.md")]),
      async (f) => {
        expect(await dryRun(f)).toEqual({
          duplicates: 0,
          moves: 0,
          removedSourceFolders: 0,
          removedSourceFiles: 0,
          skipped: 0,
        })
        await runCleanup(f, `wjob_${f.id}_mirror_cleanup_noop`)
        expect(mainSha(f)).toBe(f.sha)
      },
    )
  },
)

it(
  "keeps the mirrors of every repository when a source file cannot be read",
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture(
      fixture([
        source,
        // A source file with no front matter: it can be any repository.
        { path: "sources/github/acme/broken.md", body: "not a source\n" },
        mirror("github/pulls/acme/gone/4--14.md"),
      ]),
      async (f) => {
        expect(await dryRun(f)).toMatchObject({
          removedSourceFolders: 0,
          removedSourceFiles: 0,
        })
        await runCleanup(f, `wjob_${f.id}_mirror_cleanup_fenced`)
        expect(mainSha(f)).toBe(f.sha)
      },
    )
  },
)
