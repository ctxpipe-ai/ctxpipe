import { describe, expect, it, vi } from "vitest"
import { WRITE_JOB_STATUSES } from "./write-job-intent.js"
import { resumePausedWriteJobs } from "./write-job-resume.js"

describe("resumePausedWriteJobs", () => {
  it("claims and re-enqueues current-generation paused links when writable", async () => {
    const claim = vi.fn().mockResolvedValue(true)
    const enqueue = vi.fn().mockResolvedValue(undefined)
    const log = { error: vi.fn() }
    const resumed = await resumePausedWriteJobs({
      orgId: "org_1",
      workspaceId: "ws_1",
      writeStatus: "writable",
      desiredGeneration: 1,
      desiredWorkspaceUrl: "https://github.com/acme/docs",
      jobs: [
        {
          id: "wjob_link",
          kind: "link_unlink",
          generation: 1,
          desiredSha: null,
          status: WRITE_JOB_STATUSES.paused,
          payload: {
            linkAction: "link",
            linkGitUrl: "https://github.com/acme/app.git",
            jobWorkspaceUrl: "https://github.com/acme/docs",
          },
        },
        {
          id: "wjob_stale",
          kind: "bootstrap",
          generation: 1,
          desiredSha: null,
          status: WRITE_JOB_STATUSES.paused,
          payload: { jobWorkspaceUrl: "https://github.com/acme/old" },
        },
      ],
      claim,
      enqueue,
      log,
    })
    expect(resumed).toEqual(["wjob_link"])
    expect(claim).toHaveBeenCalledWith("wjob_link")
    expect(claim).not.toHaveBeenCalledWith("wjob_stale")
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "wjob_link",
        kind: "link_unlink",
        linkGitUrl: "https://github.com/acme/app.git",
      }),
      log,
    )
  })

  it("skips a job another replica already claimed", async () => {
    const claim = vi.fn().mockResolvedValue(false)
    const enqueue = vi.fn()
    await resumePausedWriteJobs({
      orgId: "org_1",
      workspaceId: "ws_1",
      writeStatus: "writable",
      desiredGeneration: 1,
      desiredWorkspaceUrl: "https://github.com/acme/docs",
      jobs: [
        {
          id: "wjob_link",
          kind: "link_unlink",
          generation: 1,
          desiredSha: null,
          status: WRITE_JOB_STATUSES.paused,
          payload: { jobWorkspaceUrl: "https://github.com/acme/docs" },
        },
      ],
      claim,
      enqueue,
      log: { error: vi.fn() },
    })
    expect(enqueue).not.toHaveBeenCalled()
  })
})
