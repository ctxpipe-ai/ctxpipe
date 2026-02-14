import { describe, it, expect } from "vitest"
import { createApp } from "../../app/app.js"

describe("GET /v1/health", () => {
  it("returns 200 and status ok", async () => {
    const app = createApp()
    const res = await app.request("/v1/health")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; timestamp: string }
    expect(body).toHaveProperty("status", "ok")
    expect(body).toHaveProperty("timestamp")
    expect(typeof body.timestamp).toBe("string")
  })
})
