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
  it("stores the paused job fields so it can resume", () => {
    expect(
      writeJobIntentPayload({
        kind: "bootstrap",
        jobWorkspaceUrl: "https://github.com/acme/docs",
      }),
    ).toEqual({
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
  it("replays the stored payload onto the same job id", () => {
    expect(
      enqueueInputFromPausedJob({
        orgId: "org_1",
        workspaceId: "ws_1",
        job: {
          id: "wjob_link",
          kind: "bootstrap",
          generation: 1,
          desiredSha: null,
          payload: {
            jobWorkspaceUrl: "https://github.com/acme/docs",
          },
        },
      }),
    ).toEqual({
      orgId: "org_1",
      workspaceId: "ws_1",
      kind: "bootstrap",
      jobId: "wjob_link",
      jobGeneration: 1,
      jobDesiredSha: null,
      jobWorkspaceUrl: "https://github.com/acme/docs",
    })
  })

  it("resumes a publish job with no stored pipeline as legacy, not with the current switch", () => {
    for (const kind of [
      "extract_ingest",
      "ownership_migration",
      "unlink_retraction",
    ] as const)
      expect(
        enqueueInputFromPausedJob({
          orgId: "org_1",
          workspaceId: "ws_1",
          job: {
            id: `wjob_${kind}`,
            kind,
            generation: 1,
            desiredSha: null,
            payload: { jobWorkspaceUrl: "https://github.com/acme/docs" },
          },
        }).publishPipeline,
      ).toBe("legacy")
  })

  it("resumes a publish job with its stored pipeline, and gives no pipeline to another kind", () => {
    const resume = (
      kind: "ownership_migration" | "claims_upgrade",
      payload: { publishPipeline?: "v2" },
    ) =>
      enqueueInputFromPausedJob({
        orgId: "org_1",
        workspaceId: "ws_1",
        job: { id: "wjob_1", kind, generation: 1, desiredSha: null, payload },
      }).publishPipeline
    expect(resume("ownership_migration", { publishPipeline: "v2" })).toBe("v2")
    expect(resume("claims_upgrade", {})).toBeUndefined()
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
