import { describe, expect, it } from "vitest"
import {
  countsTowardWriteJobAttempts,
  enqueueInputFromPausedJob,
  shouldResumePausedWriteJob,
  WRITE_JOB_STATUSES,
  writeJobIntentPayload,
  writeJobIntentStatus,
} from "./write-job-intent.js"

describe("writeJobIntentPayload", () => {
  it("stores first-create link fields so a paused job can resume", () => {
    expect(
      writeJobIntentPayload({
        kind: "link_unlink",
        linkAction: "link",
        linkGitUrl: "https://github.com/acme/app.git",
        jobWorkspaceUrl: "https://github.com/acme/docs",
      }),
    ).toEqual({
      linkAction: "link",
      linkGitUrl: "https://github.com/acme/app.git",
      jobWorkspaceUrl: "https://github.com/acme/docs",
    })
  })
})

describe("writeJobIntentStatus", () => {
  it("pauses when write status is unknown or read-only", () => {
    expect(
      writeJobIntentStatus({
        writeStatus: "unknown",
        jobGeneration: 1,
        desiredGeneration: 1,
      }),
    ).toBe(WRITE_JOB_STATUSES.paused)
    expect(
      writeJobIntentStatus({
        writeStatus: "read_only",
        jobGeneration: 1,
        desiredGeneration: 1,
      }),
    ).toBe(WRITE_JOB_STATUSES.paused)
  })

  it("queues when the current generation is writable", () => {
    expect(
      writeJobIntentStatus({
        writeStatus: "writable",
        jobGeneration: 2,
        desiredGeneration: 2,
      }),
    ).toBe(WRITE_JOB_STATUSES.queued)
  })

  it("does not pause a stale generation after relink", () => {
    expect(
      writeJobIntentStatus({
        writeStatus: "writable",
        jobGeneration: 1,
        desiredGeneration: 2,
      }),
    ).toBe("stale_generation")
  })
})

describe("shouldResumePausedWriteJob", () => {
  it("resumes a current-generation paused job once the remote is writable", () => {
    expect(
      shouldResumePausedWriteJob({
        status: WRITE_JOB_STATUSES.paused,
        generation: 1,
        desiredGeneration: 1,
        writeStatus: "writable",
        jobWorkspaceUrl: "https://github.com/acme/docs",
        desiredWorkspaceUrl: "https://github.com/acme/docs",
      }),
    ).toBe(true)
  })

  it("leaves paused jobs parked after relink or while still unwritable", () => {
    expect(
      shouldResumePausedWriteJob({
        status: WRITE_JOB_STATUSES.paused,
        generation: 1,
        desiredGeneration: 2,
        writeStatus: "writable",
        jobWorkspaceUrl: "https://github.com/acme/old",
        desiredWorkspaceUrl: "https://github.com/acme/new",
      }),
    ).toBe(false)
    expect(
      shouldResumePausedWriteJob({
        status: WRITE_JOB_STATUSES.paused,
        generation: 1,
        desiredGeneration: 1,
        writeStatus: "read_only",
        jobWorkspaceUrl: "https://github.com/acme/docs",
        desiredWorkspaceUrl: "https://github.com/acme/docs",
      }),
    ).toBe(false)
  })
})

describe("enqueueInputFromPausedJob", () => {
  it("replays the stored link payload onto the same job id", () => {
    expect(
      enqueueInputFromPausedJob({
        orgId: "org_1",
        workspaceId: "ws_1",
        job: {
          id: "wjob_link",
          kind: "link_unlink",
          generation: 1,
          desiredSha: null,
          payload: {
            linkAction: "link",
            linkGitUrl: "https://github.com/acme/app.git",
            jobWorkspaceUrl: "https://github.com/acme/docs",
          },
        },
      }),
    ).toEqual({
      orgId: "org_1",
      workspaceId: "ws_1",
      kind: "link_unlink",
      jobId: "wjob_link",
      jobGeneration: 1,
      jobDesiredSha: null,
      jobWorkspaceUrl: "https://github.com/acme/docs",
      linkAction: "link",
      linkGitUrl: "https://github.com/acme/app.git",
    })
  })
})

describe("countsTowardWriteJobAttempts", () => {
  it("ignores parked intents that never ran", () => {
    expect(countsTowardWriteJobAttempts(WRITE_JOB_STATUSES.paused)).toBe(false)
    expect(countsTowardWriteJobAttempts(WRITE_JOB_STATUSES.queued)).toBe(false)
    expect(countsTowardWriteJobAttempts(WRITE_JOB_STATUSES.running)).toBe(true)
    expect(countsTowardWriteJobAttempts(WRITE_JOB_STATUSES.completed)).toBe(
      true,
    )
  })
})
