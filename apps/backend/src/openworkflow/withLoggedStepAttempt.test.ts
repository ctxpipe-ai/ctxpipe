import { beforeEach, describe, expect, it, vi } from "vitest"

const flushWorkflowLogMock = vi.hoisted(() => vi.fn())
const getLoggerErrorMock = vi.hoisted(() => vi.fn())

vi.mock("../observability/logger.js", () => ({
  flushWorkflowLog: flushWorkflowLogMock,
  getLogger: () => ({ error: getLoggerErrorMock }),
}))

import { withLoggedStepAttempt } from "./withLoggedStepAttempt.js"

describe("withLoggedStepAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the result when fn succeeds without logging", async () => {
    const result = await withLoggedStepAttempt(
      "some-step",
      { repositoryId: "repo_1", orgId: "org_1" },
      async () => "success",
    )

    expect(result).toBe("success")
    expect(getLoggerErrorMock).not.toHaveBeenCalled()
    expect(flushWorkflowLogMock).not.toHaveBeenCalled()
  })

  it("logs structured error and flushes then rethrows on non-SleepSignal throw", async () => {
    const err = new Error("step blew up")

    await expect(
      withLoggedStepAttempt(
        "reindexStep",
        { repositoryId: "repo_1", orgId: "org_1" },
        async () => {
          throw err
        },
      ),
    ).rejects.toThrow("step blew up")

    expect(getLoggerErrorMock).toHaveBeenCalledOnce()
    expect(getLoggerErrorMock).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        step: "repository-ingestion.step.reindexStep.attempt_failed",
        workflow: "repository-ingestion",
        stepName: "reindexStep",
        repositoryId: "repo_1",
        orgId: "org_1",
        errMessage: "step blew up",
        errName: "Error",
      }),
    )
    expect(flushWorkflowLogMock).toHaveBeenCalledOnce()
  })

  it("normalises non-Error throws into an Error before logging", async () => {
    await expect(
      withLoggedStepAttempt(
        "some-step",
        { repositoryId: "repo_1", orgId: "org_1" },
        async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "raw string error"
        },
      ),
    ).rejects.toThrow("raw string error")

    expect(getLoggerErrorMock).toHaveBeenCalledOnce()
    const [firstArg] = getLoggerErrorMock.mock.calls[0] as [Error]
    expect(firstArg).toBeInstanceOf(Error)
    expect(firstArg.message).toBe("raw string error")
  })

  it("rethrows SleepSignal without logging or flushing", async () => {
    const sleepSignal = new Error("sleep")
    sleepSignal.name = "SleepSignal"

    await expect(
      withLoggedStepAttempt(
        "some-step",
        { repositoryId: "repo_1", orgId: "org_1" },
        async () => {
          throw sleepSignal
        },
      ),
    ).rejects.toMatchObject({ name: "SleepSignal" })

    expect(getLoggerErrorMock).not.toHaveBeenCalled()
    expect(flushWorkflowLogMock).not.toHaveBeenCalled()
  })

  it("includes truncated stack in the log fields", async () => {
    const err = new Error("oops")
    err.stack = "Error: oops\n" + "  at frame\n".repeat(200)

    await expect(
      withLoggedStepAttempt(
        "ingest",
        { repositoryId: "repo_1", orgId: "org_1" },
        async () => {
          throw err
        },
      ),
    ).rejects.toThrow("oops")

    const [, fields] = getLoggerErrorMock.mock.calls[0] as [
      Error,
      Record<string, unknown>,
    ]
    expect(typeof fields["stack"]).toBe("string")
    expect((fields["stack"] as string).length).toBeLessThanOrEqual(1000)
  })
})
