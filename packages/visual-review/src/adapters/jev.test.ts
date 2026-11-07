import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import sharp from "sharp"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest"

import { areas, qualities, verdictSchema, type StoryInput } from "../index.ts"
import { judgeWithJev } from "./jev.ts"

type DecisionsBody = {
  model: string
  state: (string | { type: "image_url"; image_url: { url: string } })[]
  questions: Record<
    string,
    { type: string; instructions?: unknown; criteria?: unknown }
  >
}

const baseUrl = "https://openrouter.test/api/v1"
const endpoint = "https://openrouter.test/api/alpha/decisions"

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

const dir = await mkdtemp(join(tmpdir(), "jev-"))
const png = async (name: string, width: number, height: number) => {
  const path = join(dir, name)
  await writeFile(
    path,
    await sharp({
      create: { width, height, channels: 3, background: "#18181b" },
    })
      .png()
      .toBuffer(),
  )
  return path
}

const story = async (overrides: Partial<StoryInput> = {}) =>
  ({
    storyId: "connectors-card--connected",
    scope: "component",
    viewport: { width: 1440, height: 900 },
    regions: [
      {
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        changeType: "content-change",
        position: "top-left",
        confidence: 0.9,
      },
    ],
    images: [
      { role: "regions", path: await png("regions.png", 600, 300) },
      { role: "after", path: await png("after.png", 800, 500) },
    ],
    ...overrides,
  }) satisfies StoryInput

const choice = (better: number, same: number, worse: number) => {
  const probabilities = { better, same, worse }
  const picked = Object.entries(probabilities).sort(
    (a, b) => b[1] - a[1],
  )[0]![0]
  return {
    type: "choice",
    choice: picked,
    confidence: probabilities[picked as keyof typeof probabilities],
    probabilities,
  }
}
const fine = choice(0.02, 0.97, 0.01)
const defect = (noul: number) => ({ type: "noul", noul })
const box = (top: number, bottom: number, left: number, right: number) => ({
  type: "box",
  box: { top, bottom, left, right },
  confidence: 0.9,
})

/**
 * Answer a decisions request. `answer` returns the answer of each question
 * name. The request body and headers are kept for the test to read.
 */
const serve = (
  answer: (name: string) => unknown,
  usage: unknown = { input_tokens: 900, output_tokens: 30, cost: 0.0000378 },
) => {
  const seen: { body?: DecisionsBody; headers?: Headers } = {}
  server.use(
    http.post(endpoint, async ({ request }) => {
      const body = (await request.json()) as DecisionsBody
      seen.body = body
      seen.headers = request.headers
      return HttpResponse.json({
        id: "gen-1",
        model: "typesafe/jev-1.14-20261001",
        provider: "TypeSafe",
        answers: Object.fromEntries(
          Object.keys(body.questions).map((name) => [name, answer(name)]),
        ),
        usage,
      })
    }),
  )
  return seen
}

const options = { apiKey: "test-key", baseUrl }

const sentImage = async (body: DecisionsBody, index: number) => {
  const parts = body.state.filter((part) => typeof part !== "string")
  const url = parts[index]!.image_url.url
  expect(url).toMatch(/^data:image\/(png|jpeg);base64,/)
  const meta = await sharp(
    Buffer.from(url.slice(url.indexOf(",") + 1), "base64"),
  ).metadata()
  return { width: meta.width, height: meta.height }
}

describe("judgeWithJev questions", () => {
  test("asks one question for each area and quality, and skips page-only qualities for a component", async () => {
    const seen = serve(() => fine)
    await judgeWithJev(await story(), options)
    const names = Object.keys(seen.body!.questions)
    for (const { id } of areas) expect(names).toContain(`area.${id}`)
    for (const { id, pageOnly } of qualities)
      expect(names.includes(`quality.${id}`)).toBe(!pageOnly)
    expect(seen.body!.model).toBe("typesafe/jev-1.14")
    expect(seen.body!.questions["defect"]?.type).toBe("noul")
    expect(seen.body!.questions["defect-box"]?.type).toBe("box")
    expect(seen.body!.questions["area.spacing"]?.type).toBe("choice")
    expect(
      Object.keys(seen.body!.questions["area.spacing"]!.criteria as object),
    ).toEqual(["better", "same", "worse"])
  })

  test("asks the page-only qualities for a page", async () => {
    const seen = serve(() => fine)
    await judgeWithJev(await story({ scope: "page" }), options)
    expect(Object.keys(seen.body!.questions)).toContain("quality.focus")
  })

  test("sends the images as data URLs, with the key and the images header", async () => {
    const seen = serve(() => fine)
    await judgeWithJev(await story(), options)
    expect(seen.headers!.get("authorization")).toBe("Bearer test-key")
    expect(seen.headers!.get("typesafe-danger-zone-images")).toBe("true")
    expect(
      seen.body!.state.filter((part) => typeof part !== "string"),
    ).toHaveLength(2)
  })
})

describe("judgeWithJev verdict", () => {
  test("a worse area with a defect becomes a regression with a region in fractions of the after image", async () => {
    serve((name) => {
      if (name === "area.spacing") return choice(0, 0.05, 0.95)
      if (name === "quality.consistency") return choice(0, 0.2, 0.8)
      if (name === "defect") return defect(0.92)
      if (name === "defect-box") return box(0.2, 0.5, 0.1, 0.4)
      return fine
    })
    const verdict = await judgeWithJev(await story(), options)
    expect(verdictSchema.parse(verdict)).toEqual(verdict)
    expect(verdict.verdict).toBe("regression")
    expect(verdict.severity).toBe("major")
    expect(verdict.confidence).toBeCloseTo(0.95)
    expect(verdict.storyId).toBe("connectors-card--connected")
    expect(verdict.model).toBe("typesafe/jev-1.14-20261001")
    expect(verdict.costUsd).toBeCloseTo(0.0000378)
    expect(verdict.latencyMs).toBeGreaterThanOrEqual(0)
    expect(verdict.observations).toEqual([])
    expect(verdict.findings).toHaveLength(1)
    const [finding] = verdict.findings
    expect(finding?.kind).toBe("spacing")
    expect(finding?.evidence).toBe("")
    expect(finding?.explainedByBrief).toBe(false)
    expect(finding?.region.x).toBeCloseTo(0.1)
    expect(finding?.region.y).toBeCloseTo(0.2)
    expect(finding?.region.width).toBeCloseTo(0.3)
    expect(finding?.region.height).toBeCloseTo(0.3)
    expect(verdict.qualities).toContainEqual({
      name: "consistency",
      delta: "worse",
      confidence: 0.8,
    })
    expect(verdict.qualities.map(({ name }) => name)).not.toContain("focus")
  })

  test("a box on a padded image maps back to the fractions of the real image", async () => {
    // 400 x 100 is padded to 400 x 280 at the bottom; the box is on the padded image.
    const seen = serve((name) => {
      if (name === "area.alignment") return choice(0, 0.1, 0.9)
      if (name === "defect") return defect(0.9)
      if (name === "defect-box") return box(0.1, 0.2, 0.5, 1)
      return fine
    })
    const wide = await png("wide.png", 400, 100)
    const verdict = await judgeWithJev(
      await story({ images: [{ role: "after", path: wide }] }),
      options,
    )
    expect(await sentImage(seen.body!, 0)).toEqual({ width: 400, height: 280 })
    const region = verdict.findings[0]!.region
    expect(region.y).toBeCloseTo(0.28) // 0.1 * 280 / 100
    expect(region.height).toBeCloseTo(0.28) // 0.1 * 280 / 100
    expect(region.x).toBeCloseTo(0.5)
    expect(region.width).toBeCloseTo(0.5)
  })

  test("a box that runs into the padding stops at the edge of the real image", async () => {
    serve((name) => {
      if (name === "area.alignment") return choice(0, 0.1, 0.9)
      if (name === "defect") return defect(0.9)
      if (name === "defect-box") return box(0.2, 0.9, 0, 1)
      return fine
    })
    const wide = await png("wide2.png", 400, 100)
    const verdict = await judgeWithJev(
      await story({ images: [{ role: "after", path: wide }] }),
      options,
    )
    const { y, height } = verdict.findings[0]!.region
    expect(y + height).toBeCloseTo(1)
  })

  test("nothing worse is intended when a brief explains the change", async () => {
    serve((name) => (name === "defect" ? defect(0.03) : fine))
    const verdict = await judgeWithJev(
      await story({ brief: "Rename the button." }),
      options,
    )
    expect(verdict.verdict).toBe("intended")
    expect(verdict.severity).toBe("none")
    expect(verdict.findings).toEqual([])
    expect(verdict.confidence).toBeGreaterThan(0.9)
  })

  test("nothing worse without a brief or diff is unsure, as the schema rule says", async () => {
    serve((name) => (name === "defect" ? defect(0.03) : fine))
    const verdict = await judgeWithJev(await story(), options)
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.severity).toBe("none")
    expect(verdict.error).toBeUndefined()
  })

  test("a doubtful answer is unsure, not intended", async () => {
    serve((name) => {
      if (name === "quality.hierarchy") return choice(0, 0.65, 0.35)
      if (name === "defect") return defect(0.1)
      return fine
    })
    const verdict = await judgeWithJev(
      await story({ brief: "Rename the button." }),
      options,
    )
    expect(verdict.verdict).toBe("unsure")
  })

  test("a refused question makes the verdict unsure, not intended", async () => {
    serve((name) => {
      if (name === "quality.clarity") return { type: "refusal" }
      if (name === "defect") return defect(0.03)
      return fine
    })
    const verdict = await judgeWithJev(
      await story({ brief: "Rename the button." }),
      options,
    )
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.summary).toContain("1 questions")
    expect(verdict.qualities.map(({ name }) => name)).not.toContain("clarity")
  })

  test("a response with no answers is unsure, not intended", async () => {
    serve(() => undefined)
    const verdict = await judgeWithJev(
      await story({ brief: "Rename the button." }),
      options,
    )
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.confidence).toBe(0)
    expect(verdict.qualities).toEqual([])
  })

  test("a defect with no worse area gets a finding for the area that is the most likely worse", async () => {
    serve((name) => {
      if (name === "area.overflow") return choice(0, 0.6, 0.4)
      if (name === "defect") return defect(0.8)
      if (name === "defect-box") return box(0.5, 0.6, 0.5, 0.6)
      return fine
    })
    const verdict = await judgeWithJev(await story(), options)
    expect(verdict.verdict).toBe("regression")
    expect(verdict.findings).toHaveLength(1)
    expect(verdict.findings[0]?.kind).toBe("overflow")
    expect(verdict.findings[0]?.region.x).toBeCloseTo(0.5)
  })

  test("with no image to place a box on, a finding takes the measured regions", async () => {
    const seen = serve((name) => {
      if (name === "area.contrast") return choice(0, 0.1, 0.9)
      if (name === "defect") return defect(0.9)
      return fine
    })
    const verdict = await judgeWithJev(
      await story({
        images: [{ role: "regions", path: await png("r.png", 600, 300) }],
      }),
      options,
    )
    expect(Object.keys(seen.body!.questions)).not.toContain("defect-box")
    expect(verdict.verdict).toBe("regression")
    expect(verdict.findings[0]?.kind).toBe("contrast")
    const region = verdict.findings[0]!.region
    expect(region.x).toBeCloseTo(0.1)
    expect(region.y).toBeCloseTo(0.2)
    expect(region.width).toBeCloseTo(0.3)
    expect(region.height).toBeCloseTo(0.1)
  })
})

describe("judgeWithJev images", () => {
  test("pads a side under 280 px", async () => {
    const seen = serve(() => fine)
    const small = await png("small.png", 200, 150)
    await judgeWithJev(
      await story({ images: [{ role: "after", path: small }] }),
      options,
    )
    expect(await sentImage(seen.body!, 0)).toEqual({ width: 280, height: 280 })
  })

  test("scales an image down to at most 1568 px a side, and pads the short side", async () => {
    const seen = serve(() => fine)
    const tall = await png("tall.png", 3136, 100)
    await judgeWithJev(
      await story({ images: [{ role: "after", path: tall }] }),
      options,
    )
    expect(await sentImage(seen.body!, 0)).toEqual({ width: 1568, height: 280 })
  })

  test("keeps an image that is within the limits as it is", async () => {
    const seen = serve(() => fine)
    await judgeWithJev(await story(), options)
    expect(await sentImage(seen.body!, 1)).toEqual({ width: 800, height: 500 })
  })
})

describe("judgeWithJev errors", () => {
  test.each([
    [400, "Images are not enabled"],
    [413, "Payload too large"],
  ])("a %i answer gives unsure with the error", async (status, message) => {
    server.use(
      http.post(endpoint, () =>
        HttpResponse.json(
          { error: { code: status, message, metadata: null } },
          { status },
        ),
      ),
    )
    const verdict = await judgeWithJev(await story(), options)
    expect(verdictSchema.parse(verdict)).toEqual(verdict)
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.severity).toBe("none")
    expect(verdict.confidence).toBe(0)
    expect(verdict.error).toContain(String(status))
    expect(verdict.error).toContain(message)
  })

  test("another failure throws, so that the caller can retry", async () => {
    server.use(
      http.post(endpoint, () =>
        HttpResponse.json(
          { error: { code: 429, message: "Slow down" } },
          { status: 429 },
        ),
      ),
    )
    await expect(judgeWithJev(await story(), options)).rejects.toThrow(
      /429.*Slow down/,
    )
  })

  test("the key and URL come from the model provider variables", async () => {
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "env-key")
    vi.stubEnv("MODEL_PROVIDER_URL", baseUrl)
    const seen = serve(() => fine)
    await judgeWithJev(await story())
    expect(seen.headers!.get("authorization")).toBe("Bearer env-key")
  })

  test("an unknown cost is null", async () => {
    serve(() => fine, { input_tokens: 10, output_tokens: 1 })
    const verdict = await judgeWithJev(await story(), options)
    expect(verdict.costUsd).toBeNull()
  })

  test("without a key it throws before any request", async () => {
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "")
    await expect(judgeWithJev(await story(), { baseUrl })).rejects.toThrow(
      /MODEL_PROVIDER_API_KEY/,
    )
  })
})
