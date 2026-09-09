import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { captureGitPack } from "../../services/git/pack.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { pushWorkspaceCommit } from "./write-broker.js"

it.each(["bytes", "objects"] as const)(
  "rejects oversized extraction %s before native admission",
  { timeout: 30_000 },
  async (limit) => {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable", writeStatus: "writable" },
      async (f) => {
        const errors: Error[] = []
        const result = await withOrgIdContext(f.org, () =>
          enqueueWriteJob(
            {
              orgId: f.org.id,
              workspaceId: f.workspaceId,
              jobId: `wjob_${f.id}_oversized`,
              kind: "extract_ingest",
              extraction: {
                repositoryId: "repo_captured",
                repositoryUrl: f.workspaceUrl,
                sourceSha: f.sha,
                objects:
                  limit === "bytes"
                    ? [
                        {
                          kind: "Service",
                          deduplicationKey: "svc:billing",
                          summary: "x".repeat(8 * 1024 * 1024),
                        },
                      ]
                    : Array.from({ length: 10_001 }, (_, index) => ({
                        kind: "Service",
                        deduplicationKey: `svc:${index}`,
                        name: "Service",
                      })),
                claims: [],
              },
            },
            { error: (error) => errors.push(error) },
          ),
        )
        expect(result).toEqual({ started: false })
        expect(errors).toHaveLength(1)
        expect(errors[0]?.message).toContain(
          limit === "bytes" ? "Extraction capture exceeds 8 MiB" : "10000",
        )
        expect(
          f.git("--git-dir", f.remote, "diff", "--name-only", f.sha, "main"),
        ).toBe("")
      },
    )
  },
)

it.each(["git", "branch", "custom", "body", "canonical path"] as const)(
  "extraction publication cannot alter source declaration %s",
  { timeout: 30_000 },
  async (field) => {
    const path = "repositories/source.md"
    const original =
      "---\ngit: https://github.com/fixture/source\nbranch: main\ncustom: owner\n---\nOwner notes.\n"
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        writeStatus: "writable",
        files: [{ path, body: original }],
      },
      async (f) => {
        await f.handle.cancel()
        const blobSha = f.git("rev-parse", `${f.sha}:${path}`)
        f.git("reset", "--hard", f.sha)
        const changed =
          field === "git"
            ? original.replace("fixture/source", "fixture/other")
            : field === "branch"
              ? original.replace("branch: main", "branch: other")
              : field === "custom"
                ? original.replace("custom: owner", "custom: agent")
                : field === "body"
                  ? original.replace("Owner notes.", "Agent rewrite.")
                  : original
        const changedPath =
          field === "canonical path" ? "repositories/0-source.md" : path
        writeFileSync(join(f.directory, changedPath), changed)
        f.git("add", changedPath)
        f.git("commit", "-m", "Attempt to change source authority")
        const committed = await captureGitPack(
          f.directory,
          f.git("rev-parse", "HEAD"),
        )
        await expect(
          withOrgIdContext(f.org, () =>
            pushWorkspaceCommit(
              {
                orgId: f.org.id,
                workspaceId: f.workspaceId,
                extraction: {
                  repositoryId: "repo_captured",
                  repositoryUrl: "https://github.com/fixture/source",
                  sourceSha: f.sha,
                  sourceDeclaration: { path, blobSha },
                  objects: [],
                  claims: [],
                },
              },
              { ...f.revision, access: "write-default" },
              committed,
              parseEnv(process.env),
            ),
          ),
        ).rejects.toThrow(
          "Extraction may only update claims in its source declaration",
        )
        expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(f.sha)
        expect(f.tokenRequests).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              permissions: expect.objectContaining({ contents: "write" }),
            }),
          ]),
        )
      },
    )
  },
)
