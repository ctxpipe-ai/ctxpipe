import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { usdAudRate } from "./fx"

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe("usdAudRate", () => {
  test("reads the USD/AUD rate from Frankfurter v2", async () => {
    server.use(
      http.get("https://api.frankfurter.dev/v2/rates", ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get("base")).toBe("USD")
        expect(url.searchParams.get("quotes")).toBe("AUD")
        expect(url.searchParams.get("providers")).toBe("ecb")
        return HttpResponse.json([{ date: "2026-09-25", base: "USD", quote: "AUD", rate: 1.4224 }])
      }),
    )
    await expect(usdAudRate()).resolves.toBe(1.4224)
  })

  test("throws on a non-OK response", async () => {
    server.use(http.get("https://api.frankfurter.dev/v2/rates", () => new HttpResponse("nope", { status: 503 })))
    await expect(usdAudRate()).rejects.toThrow("Frankfurter HTTP 503: nope")
  })

  test("throws when the rate is not finite", async () => {
    server.use(http.get("https://api.frankfurter.dev/v2/rates", () => HttpResponse.json([{ base: "USD", quote: "AUD", rate: "x" }])))
    await expect(usdAudRate()).rejects.toThrow("Frankfurter USD/AUD rate is not finite")
  })

  test("skips a malformed rate item and uses the next finite rate", async () => {
    server.use(
      http.get("https://api.frankfurter.dev/v2/rates", () => HttpResponse.json([{ rate: "x" }, { date: "2026-09-25", base: "USD", quote: "AUD", rate: 1.4224 }])),
    )
    await expect(usdAudRate()).resolves.toBe(1.4224)
  })

  test("throws when the JSON body is null", async () => {
    server.use(http.get("https://api.frankfurter.dev/v2/rates", () => HttpResponse.json(null)))
    await expect(usdAudRate()).rejects.toThrow("Frankfurter response was missing rates")
  })
})
