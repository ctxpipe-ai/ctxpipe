import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { captureWorkspaceRevision } from "../../models/workspaces.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import { workspaceHttpApp } from "../../test/workspace-http-fixture.js"
import { workspaceRoutes } from "./workspaces.js"

/** Commit the given files (`null` removes one), push, and hydrate the new tip. */
async function hydrateCommit(
  f: NativeHydrationFixture,
  previousSha: string,
  files: Record<string, string | null>,
) {
  for (const [path, body] of Object.entries(files)) {
    const target = join(f.directory, path)
    if (body === null) {
      rmSync(target)
      continue
    }
    mkdirSync(join(target, ".."), { recursive: true })
    writeFileSync(target, body)
  }
  f.git("add", "-A", "--", ...Object.keys(files))
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Contract",
      "-c",
      "user.email=contract@example.test",
      "commit",
      "-m",
      "Change knowledge files",
    ],
    { cwd: f.directory, encoding: "utf8" },
  )
  const sha = f.git("rev-parse", "HEAD")
  f.git("push", f.remote, "HEAD:main")
  const revision = await withOrgIdContext(f.org, () =>
    captureWorkspaceRevision({
      workspaceId: f.workspaceId,
      expected: {
        generation: 1,
        url: f.workspaceUrl,
        sha: previousSha,
        defaultBranch: "main",
        githubConnectionId: null,
      },
      tip: { sha, branch: "main" },
    }),
  )
  if (!revision) throw new Error("Fixture revision was not captured")
  const run = await f.runner.runWorkflow(workspaceHydrate.spec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    revision,
  })
  expect(await run.result({ timeoutMs: 30_000 })).toMatchObject({
    hydrated: true,
  })
  return sha
}

it(
  "keeps the skipped files of the active projection and clears them when a hydrate reads every file",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture({}, async (f) => {
      await f.publish()
      const app = workspaceHttpApp(f.org, workspaceRoutes)
      const skippedFiles = async () => {
        const response = await app.request("/workspaces/knowledge")
        expect(response.status).toBe(200)
        return ((await response.json()) as { skippedFiles: unknown })
          .skippedFiles
      }
      expect(await skippedFiles()).toEqual([])

      const declaration = "---\ngit: https://example.test/linked.git\n---\n"
      const brokenSha = await hydrateCommit(f, f.sha, {
        "broken.md": "---\nUnclosed front matter\n",
        "repositories/first.md": declaration,
        "repositories/second.md": declaration,
      })
      expect(await skippedFiles()).toEqual([
        { path: "broken.md", reason: "malformed" },
        { path: "repositories/second.md", reason: "duplicate_repository" },
      ])
      const listed = await app.request("/workspaces")
      expect(
        ((await listed.json()) as { items: Array<{ skippedFiles: unknown }> })
          .items[0]?.skippedFiles,
      ).toHaveLength(2)

      await hydrateCommit(f, brokenSha, {
        "broken.md": "---\ntitle: Fixed\n---\nFixed front matter.\n",
        "repositories/second.md": null,
      })
      expect(await skippedFiles()).toEqual([])
    }),
)
