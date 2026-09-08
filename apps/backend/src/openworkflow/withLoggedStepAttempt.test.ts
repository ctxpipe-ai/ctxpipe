import { beforeEach, describe, expect, it } from "vitest"
import { withTestLogger } from "../test/with-test-logger.js"
import { withLoggedStepAttempt } from "./withLoggedStepAttempt.js"

describe("withLoggedStepAttempt", () => {
  beforeEach(() => {})

  it("returns the result when fn succeeds", async () => {
    const result = await withTestLogger(() =>
      withLoggedStepAttempt(
        "some-step",
        {
          workflow: "repository-ingestion",
          repositoryId: "repo_1",
          orgId: "org_1",
        },
        async () => "success",
      ),
    )

    expect(result).toBe("success")
  })

  it("rethrows ordinary callback errors", async () => {
    const err = new Error("step blew up")

    await expect(
      withTestLogger(() =>
        withLoggedStepAttempt(
          "reindexStep",
          {
            workflow: "repository-ingestion",
            repositoryId: "repo_1",
            orgId: "org_1",
          },
          async () => {
            throw err
          },
        ),
      ),
    ).rejects.toThrow("step blew up")
  })

  it("normalises non-Error throws into an Error before rethrowing", async () => {
    await expect(
      withTestLogger(() =>
        withLoggedStepAttempt(
          "some-step",
          {
            workflow: "repository-ingestion",
            repositoryId: "repo_1",
            orgId: "org_1",
          },
          async () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw "raw string error"
          },
        ),
      ),
    ).rejects.toThrow("raw string error")
  })

  it("rethrows index failures labelled as repository-index", async () => {
    const err = new Error("zoekt failed")

    await expect(
      withTestLogger(() =>
        withLoggedStepAttempt(
          "zoekt",
          {
            workflow: "repository-index",
            repositoryId: "repo_1",
            orgId: "org_1",
          },
          async () => {
            throw err
          },
        ),
      ),
    ).rejects.toThrow("zoekt failed")
  })
})
