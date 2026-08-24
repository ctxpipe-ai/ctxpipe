import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ApiError,
  apiFetch,
  pollWhileOk,
  readApiJson,
  retryQuery,
} from "./api-result"

describe("retryQuery", () => {
  it("does not retry 4xx", () => {
    expect(retryQuery(0, new ApiError("conflict", 409))).toBe(false)
    expect(retryQuery(0, new ApiError("not found", 404))).toBe(false)
  })

  it("retries a 5xx once", () => {
    const error = new ApiError("upstream", 500)
    expect(retryQuery(0, error)).toBe(true)
    expect(retryQuery(1, error)).toBe(false)
  })

  it("retries a network error once", () => {
    expect(retryQuery(0, new ApiError("aborted", 0))).toBe(true)
    expect(retryQuery(0, new Error("failed to fetch"))).toBe(true)
    expect(retryQuery(1, new Error("failed to fetch"))).toBe(false)
  })
})

describe("readApiJson", () => {
  it("returns a 200 JSON body", async () => {
    const res = new Response(JSON.stringify({ sha: "abc", paths: ["a"] }), {
      status: 200,
    })
    await expect(readApiJson(res)).resolves.toEqual({
      sha: "abc",
      paths: ["a"],
    })
  })

  it("returns empty when the status is listed", async () => {
    const res = new Response(JSON.stringify({ error: "not ready" }), {
      status: 409,
    })
    await expect(
      readApiJson(res, { emptyOn: [409], empty: { sha: "", paths: [] } }),
    ).resolves.toEqual({ sha: "", paths: [] })
  })

  it("throws ApiError on 409 without emptyOn", async () => {
    const res = new Response(JSON.stringify({ error: "slug taken" }), {
      status: 409,
    })
    await expect(readApiJson(res)).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "slug taken",
    })
  })

  it("throws ApiError on 500 using the server message", async () => {
    const res = new Response(JSON.stringify({ message: "db down" }), {
      status: 500,
    })
    await expect(readApiJson(res, { message: "Failed" })).rejects.toMatchObject(
      {
        name: "ApiError",
        status: 500,
        message: "db down",
      },
    )
  })
})

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns an ApiError with status 0 when the request aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.reject(
          new DOMException("The operation was aborted.", "AbortError"),
        ),
      ),
    )
    await expect(apiFetch("http://localhost/api")).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
    })
  })
})

describe("pollWhileOk", () => {
  it("stops polling after an error", () => {
    const poll = pollWhileOk(3000)
    expect(poll({ state: { status: "error" } })).toBe(false)
    expect(poll({ state: { status: "success" } })).toBe(3000)
    expect(poll({ state: { status: "pending" } })).toBe(3000)
  })
})
