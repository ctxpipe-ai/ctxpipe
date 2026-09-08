import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { enqueueWriteJob } from "../../openworkflow/enqueue-workspace-write-commit.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"

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
