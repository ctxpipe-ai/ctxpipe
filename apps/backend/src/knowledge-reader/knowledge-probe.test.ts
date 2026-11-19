import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { probe } from "../../evals/knowledge/probe.js"
import { useMswServer } from "../../test/msw.js"

/*
 * The live provider probe (`cli.ts probe`) against a fake OpenRouter (msw).
 * The probe sends its requests through the real Jev and embedding clients;
 * these tests check the requests, the pass and fail rules, the evidence and
 * the spend cap.
 */

const BASE = "https://probe-gateway.test/api/v1"
const DECISIONS = "https://probe-gateway.test/api/alpha/decisions"
const EMBEDDINGS = `${BASE}/embeddings`

const server = useMswServer()

let out: string
beforeEach(async () => {
  vi.stubEnv("MODEL_PROVIDER_URL", BASE)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  out = await mkdtemp(join(tmpdir(), "knowledge-probe-"))
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(out, { recursive: true, force: true })
})

type Provider = { ignore?: string[] }

/**
 * A gateway that routes like OpenRouter: TypeSafe is the only endpoint of
 * Jev, so a request that ignores it gets no endpoint. With
 * `appliesProvider: false`, it ignores the provider block.
 */
function gateway(options: {
  appliesProvider: boolean
  jevProvider: string
  dimensions: number
}) {
  const bodies: { decisions: unknown[]; embeddings: unknown[] } = {
    decisions: [],
    embeddings: [],
  }
  server.use(
    http.post(DECISIONS, async ({ request }) => {
      const body = (await request.json()) as { provider: Provider }
      bodies.decisions.push(body)
      if (options.appliesProvider && body.provider.ignore?.includes("typesafe"))
        return HttpResponse.json(
          {
            error: {
              message: "No endpoints found that match your data policy.",
            },
          },
          { status: 404 },
        )
      return HttpResponse.json({
        answers: { sky: { type: "noul", noul: 0.9 } },
        provider: options.jevProvider,
        usage: { cost: 0.0001 },
      })
    }),
    http.post(EMBEDDINGS, async ({ request }) => {
      bodies.embeddings.push(await request.json())
      return HttpResponse.json({
        data: [
          {
            embedding: Array.from({ length: options.dimensions }, () => 0.1),
            index: 0,
          },
        ],
        provider: "Google",
        usage: { prompt_tokens: 4, cost: 0.00001 },
      })
    }),
  )
  return bodies
}

const readResult = async () =>
  JSON.parse(await readFile(join(out, "probe.json"), "utf8")) as {
    spentUsd: number
    stopped: boolean
    checks: {
      name: string
      pass: boolean
      status: number | null
      provider: string | null
      error: string | null
    }[]
  }

describe("the provider probe", () => {
  it("passes each check when the gateway applies the provider settings", async () => {
    const bodies = gateway({
      appliesProvider: true,
      jevProvider: "TypeSafe",
      dimensions: 1024,
    })

    expect(await probe({ out, capUsd: 0.05 })).toBe(0)

    const result = await readResult()
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: "decisions-pinned",
        pass: true,
        status: 200,
        provider: "TypeSafe",
        error: null,
      }),
      expect.objectContaining({
        name: "decisions-refused-without-zdr-endpoint",
        pass: true,
        status: 404,
        error:
          "Jev answered HTTP 404. Provider: No endpoints found that match your data policy.",
      }),
      expect.objectContaining({
        name: "embedding-image",
        pass: true,
        status: 200,
        provider: "Google",
      }),
      expect.objectContaining({
        name: "embedding-text",
        pass: true,
        status: 200,
      }),
    ])
    expect(result.stopped).toBe(false)
    expect(await readFile(join(out, "probe.md"), "utf8")).toContain(
      "| decisions-pinned | pass | 200 | TypeSafe |",
    )

    // The refused request is the request of the real client, with only
    // `ignore` added to its provider block.
    const [pinned, refused] = bodies.decisions as {
      provider: Record<string, unknown>
    }[]
    expect(pinned?.provider).toEqual({
      data_collection: "deny",
      order: ["typesafe"],
      allow_fallbacks: false,
      zdr: true,
    })
    expect(refused?.provider).toEqual({
      ...pinned?.provider,
      ignore: ["typesafe"],
    })

    // The image goes as a PNG data URI of the checkerboard fixture, to the
    // pinned provider with ZDR.
    const image = await readFile(
      new URL(
        "../../evals/knowledge/fixtures/probe-checkerboard.png",
        import.meta.url,
      ),
    )
    expect(bodies.embeddings[0]).toMatchObject({
      model: "google/gemini-embedding-2",
      dimensions: 1024,
      input: [
        {
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${image.toString("base64")}`,
              },
            },
          ],
        },
      ],
      provider: {
        data_collection: "deny",
        order: ["google-vertex"],
        allow_fallbacks: false,
        zdr: true,
      },
    })
    expect(bodies.embeddings[1]).toMatchObject({
      input: [
        { content: [{ type: "text", text: "A red and blue checkerboard." }] },
      ],
    })
  })

  it("fails each check that the answers do not prove, with the evidence", async () => {
    gateway({
      appliesProvider: false,
      jevProvider: "Other Host",
      dimensions: 768,
    })

    expect(await probe({ out, capUsd: 0.05 })).toBe(4)

    const result = await readResult()
    expect(
      result.checks.map(({ name, pass, status, provider }) => ({
        name,
        pass,
        status,
        provider,
      })),
    ).toEqual([
      {
        name: "decisions-pinned",
        pass: false,
        status: 200,
        provider: "Other Host",
      },
      {
        name: "decisions-refused-without-zdr-endpoint",
        pass: false,
        status: 200,
        provider: "Other Host",
      },
      {
        name: "embedding-image",
        pass: false,
        status: 200,
        provider: "Google",
      },
      { name: "embedding-text", pass: false, status: 200, provider: "Google" },
    ])
    expect(result.checks[2]?.error).toBe(
      "Expected 1024 dimensions at index 0, got 768",
    )
  })

  it("stops at the spend cap", async () => {
    gateway({
      appliesProvider: true,
      jevProvider: "TypeSafe",
      dimensions: 1024,
    })

    // Each Jev call reserves $0.002: the first one fits, the second not.
    expect(await probe({ out, capUsd: 0.002 })).toBe(3)

    const result = await readResult()
    expect(result.stopped).toBe(true)
    expect(result.spentUsd).toBeCloseTo(0.0001)
    expect(result.checks.map((check) => [check.pass, check.status])).toEqual([
      [true, 200],
      [false, null],
      [false, null],
      [false, null],
    ])
    expect(result.checks[2]?.error).toBe(
      "The spend cap stopped the probe before this check.",
    )
  })
})
