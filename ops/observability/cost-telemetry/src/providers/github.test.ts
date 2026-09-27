import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { useEnv } from "../test-env"
import { rows } from "./github"

const DAY = "2025-01-15"
const ITEM = {
  date: `${DAY}T02:51:08Z`,
  product: "GitHub Actions",
  sku: "actions-linux",
  quantity: 123,
  unitType: "minutes",
  pricePerUnit: 0.008,
  grossAmount: 0.984,
  discountAmount: 0.0,
  netAmount: 0.984,
  organizationName: "octo-org",
  repositoryName: "octo-org/example-repo",
}

const server = setupServer()
useEnv({ GITHUB_BILLING_TOKEN: "gh-token" })

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe("github rows", () => {
  test("maps the usage fixture and sends the billing request", async () => {
    server.use(
      http.get("https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage", ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get("year")).toBe("2025")
        expect(url.searchParams.get("month")).toBe("1")
        expect(url.searchParams.get("day")).toBe("15")
        expect(request.headers.get("Authorization")).toBe("Bearer gh-token")
        expect(request.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28")
        expect(request.headers.get("Accept")).toBe("application/vnd.github+json")
        return HttpResponse.json({ usageItems: [ITEM] })
      }),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "github",
        sku: "GitHub Actions/actions-linux",
        scope: "octo-org/example-repo",
        usage: 123,
        unit: "minutes",
        costUsd: 0.984,
        source: "reported",
      },
    ])
  })

  test("sums duplicate sku and scope rows and uses org when the repo is missing", async () => {
    server.use(
      http.get("https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage", () =>
        HttpResponse.json({
          usageItems: [
            ITEM,
            { ...ITEM, quantity: 10, netAmount: 0.08 },
            { ...ITEM, repositoryName: undefined, quantity: 4, netAmount: 0.032 },
            { ...ITEM, repositoryName: "", sku: "actions-windows", quantity: 2, netAmount: 0.016 },
          ],
        }),
      ),
    )
    const result = await rows([DAY])
    expect(result).toEqual([
      {
        day: DAY,
        provider: "github",
        sku: "GitHub Actions/actions-linux",
        scope: "octo-org/example-repo",
        usage: 133,
        unit: "minutes",
        costUsd: 1.064,
        source: "reported",
      },
      {
        day: DAY,
        provider: "github",
        sku: "GitHub Actions/actions-linux",
        scope: "org",
        usage: 4,
        unit: "minutes",
        costUsd: 0.032,
        source: "reported",
      },
      {
        day: DAY,
        provider: "github",
        sku: "GitHub Actions/actions-windows",
        scope: "org",
        usage: 2,
        unit: "minutes",
        costUsd: 0.016,
        source: "reported",
      },
    ])
  })

  test("throws on a non-OK response", async () => {
    server.use(
      http.get("https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage", () => new HttpResponse("nope", { status: 401 })),
    )
    await expect(rows([DAY])).rejects.toThrow("GitHub billing usage HTTP 401: nope")
  })

  test("throws when usageItems is missing", async () => {
    server.use(http.get("https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage", () => HttpResponse.json({})))
    await expect(rows([DAY])).rejects.toThrow("GitHub billing usage response was missing usageItems")
  })

  test("skips a malformed usage item", async () => {
    server.use(
      http.get("https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage", () =>
        HttpResponse.json({ usageItems: [ITEM, { ...ITEM, quantity: "x" }, null, "nope"] }),
      ),
    )
    await expect(rows([DAY])).resolves.toEqual([
      {
        day: DAY,
        provider: "github",
        sku: "GitHub Actions/actions-linux",
        scope: "octo-org/example-repo",
        usage: 123,
        unit: "minutes",
        costUsd: 0.984,
        source: "reported",
      },
    ])
  })

  test("throws when the JSON body is null", async () => {
    server.use(http.get("https://api.github.com/organizations/ctxpipe-ai/settings/billing/usage", () => HttpResponse.json(null)))
    await expect(rows([DAY])).rejects.toThrow("GitHub billing usage response was missing usageItems")
  })

  test("throws when the billing token is missing", async () => {
    delete process.env.GITHUB_BILLING_TOKEN
    await expect(rows([DAY])).rejects.toThrow("GITHUB_BILLING_TOKEN is required")
  })
})
