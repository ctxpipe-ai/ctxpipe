import { describe, expect, it } from "vitest"
import { mergeRetrievalObjectPayloads } from "./retrievalObjectWrite.js"

describe("mergeRetrievalObjectPayloads with reference stubs", () => {
  it("lets a later real extraction replace a reference stub and drops the stub flag", () => {
    const stub = {
      name: "acme/api#42",
      number: 42,
      inferredFromReference: true,
    }
    const real = {
      name: "acme/api#42",
      number: 42,
      url: "https://github.com/acme/api/pull/42",
      merged: true,
    }
    expect(mergeRetrievalObjectPayloads(stub, real)).toEqual(real)
  })

  it("never lets a stub clobber an existing real payload", () => {
    const real = {
      name: "acme/api#42",
      number: 42,
      merged: true,
      review_decision: "APPROVED",
    }
    const stub = {
      name: "pull request #42",
      number: 42,
      inferredFromReference: true,
    }
    expect(mergeRetrievalObjectPayloads(real, stub)).toEqual({
      ...stub,
      ...real,
    })
    expect(mergeRetrievalObjectPayloads(real, stub).review_decision).toBe(
      "APPROVED",
    )
  })
})
