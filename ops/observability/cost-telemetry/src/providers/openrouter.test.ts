import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { utcDays } from "../rows"
import { useEnv } from "../test-env"
import { rows } from "./openrouter"

const DAY = "2025-08-24"
const ITEM = {
  byok_usage_inference: 0.012,
  completion_tokens: 125,
  date: DAY,
  endpoint_id: "550e8400-e29b-41d4-a716-446655440000",
  model: "openai/gpt-4.1",
  model_permaslug: "openai/gpt-4.1-2025-04-14",
  prompt_tokens: 50,
  provider_name: "OpenAI",
  reasoning_tokens: 25,
  requests: 5,
  usage: 0.015,
}

const server = setupServer()
useEnv({ OPENROUTER_MANAGEMENT_KEY: "or-key" })

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})
afterEach(() => {
  setSystemTime()
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe("openrouter rows", () => {
  test("maps the activity fixture and sends the management-key request", async () => {
    server.use(
      http.get("https://openrouter.ai/api/v1/activity", ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get("date")).toBe(DAY)
        expect(request.headers.get("Authorization")).toBe("Bearer or-key")
        return HttpResponse.json({ data: [ITEM] })
      }),
    )
    await expect(rows(["2025-08-25"])).resolves.toEqual([
      {
        day: DAY,
        provider: "openrouter",
        sku: "openai/gpt-4.1",
        scope: "OpenAI",
        usage: 175,
        unit: "tokens",
        costUsd: 0.015,
        source: "reported",
      },
    ])
  })

  test("sums duplicate model and provider rows", async () => {
    server.use(
      http.get("https://openrouter.ai/api/v1/activity", () =>
        HttpResponse.json({
          data: [
            ITEM,
            { ...ITEM, endpoint_id: "other", prompt_tokens: 10, completion_tokens: 20, usage: 0.01 },
            { ...ITEM, provider_name: "Anthropic", prompt_tokens: 1, completion_tokens: 2, usage: 0.002 },
          ],
        }),
      ),
    )
    const result = await rows(["2025-08-25"])
    expect(result).toEqual([
      {
        day: DAY,
        provider: "openrouter",
        sku: "openai/gpt-4.1",
        scope: "OpenAI",
        usage: 205,
        unit: "tokens",
        costUsd: 0.025,
        source: "reported",
      },
      {
        day: DAY,
        provider: "openrouter",
        sku: "openai/gpt-4.1",
        scope: "Anthropic",
        usage: 3,
        unit: "tokens",
        costUsd: 0.002,
        source: "reported",
      },
    ])
  })

  test("requests the three completed UTC days before the shared window's last day", async () => {
    setSystemTime(new Date("2026-09-26T12:00:00.000Z"))
    const requested: string[] = []
    server.use(
      http.get("https://openrouter.ai/api/v1/activity", ({ request }) => {
        const date = new URL(request.url).searchParams.get("date")
        expect(date).toBeTruthy()
        expect(request.headers.get("Authorization")).toBe("Bearer or-key")
        if (date) requested.push(date)
        return HttpResponse.json({ data: [] })
      }),
    )
    await expect(rows(utcDays(Date.now(), 3))).resolves.toEqual([])
    expect([...requested].sort()).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"])
  })

  test("throws on a non-OK response", async () => {
    server.use(http.get("https://openrouter.ai/api/v1/activity", () => new HttpResponse("nope", { status: 403 })))
    await expect(rows(["2025-08-25"])).rejects.toThrow("OpenRouter activity HTTP 403: nope")
  })

  test("throws when data is missing", async () => {
    server.use(http.get("https://openrouter.ai/api/v1/activity", () => HttpResponse.json({})))
    await expect(rows(["2025-08-25"])).rejects.toThrow("OpenRouter activity response was missing data")
  })

  test("skips a malformed activity item", async () => {
    server.use(
      http.get("https://openrouter.ai/api/v1/activity", () =>
        HttpResponse.json({ data: [ITEM, { ...ITEM, prompt_tokens: "x" }, null, "nope"] }),
      ),
    )
    await expect(rows(["2025-08-25"])).resolves.toEqual([
      {
        day: DAY,
        provider: "openrouter",
        sku: "openai/gpt-4.1",
        scope: "OpenAI",
        usage: 175,
        unit: "tokens",
        costUsd: 0.015,
        source: "reported",
      },
    ])
  })

  test("throws when the JSON body is null", async () => {
    server.use(http.get("https://openrouter.ai/api/v1/activity", () => HttpResponse.json(null)))
    await expect(rows(["2025-08-25"])).rejects.toThrow("OpenRouter activity response was missing data")
  })

  test("throws when the management key is missing", async () => {
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    await expect(rows(["2025-08-25"])).rejects.toThrow("OPENROUTER_MANAGEMENT_KEY is required")
  })
})
