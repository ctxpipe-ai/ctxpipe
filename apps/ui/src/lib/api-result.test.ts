import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
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

  it("skips the default timeout when timeoutMs is null", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    )
    vi.stubGlobal("fetch", fetchMock)
    await apiFetch("http://localhost/api", { timeoutMs: null })
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      signal: undefined,
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

describe("apiFetch under Bun", () => {
  // The UI server runs on Bun. Bun keeps idle sockets in a pool. When a proxy
  // drops an idle socket without a FIN, the next request on it waits for the
  // whole timeout. This proxy forwards the first request and then goes silent
  // on that socket, as the Railway edge did on pr-280.
  it("does not send a second request on a pooled socket", () => {
    const modulePath = fileURLToPath(
      new URL("./api-result.ts", import.meta.url),
    )
    const script = `
      import net from "node:net"
      import http from "node:http"
      import { apiFetch } from ${JSON.stringify(modulePath)}
      const upstream = http.createServer((_req, res) => res.end("ok"))
      await new Promise((r) => upstream.listen(0, "127.0.0.1", r))
      const sockets = []
      const proxy = net.createServer((client) => {
        const state = { silent: false }
        sockets.push(state)
        const up = net.connect(upstream.address().port, "127.0.0.1")
        client.on("data", (d) => { if (!state.silent) up.write(d) })
        up.on("data", (d) => { if (!state.silent) client.write(d) })
        client.on("error", () => {})
        up.on("error", () => {})
      })
      await new Promise((r) => proxy.listen(0, "127.0.0.1", r))
      const url = "http://127.0.0.1:" + proxy.address().port + "/"
      await (await apiFetch(url)).text()
      for (const s of sockets) s.silent = true
      try {
        const res = await apiFetch(url, { timeoutMs: 2000 })
        console.log("second:" + (await res.text()))
      } catch (error) {
        console.log("second:" + error.name)
      }
      process.exit(0)
    `
    const out = execFileSync("bun", ["-e", script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
    })
    expect(out.trim()).toBe("second:ok")
  })
})
