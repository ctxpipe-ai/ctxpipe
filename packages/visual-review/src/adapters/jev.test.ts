import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync, crc32 } from "node:zlib"

import { decode } from "@blazediff/codec-png-native"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest"

import { areas, qualities, verdictSchema, type StoryInput } from "../index.ts"
import { judgeNewWithJev, judgeWithJev } from "./jev.ts"

type DecisionsBody = {
  model: string
  provider?: unknown
  state: (string | { type: "image_url"; image_url: { url: string } })[]
  questions: Record<
    string,
    { type: string; instructions?: unknown; criteria?: unknown }
  >
}

const defined = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected a value.")
  return value
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
// A grayscale PNG of one color, built by hand: a signature, then the chunks.
const png = async (name: string, width: number, height: number) => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 0, 0, 0, 0], 8)
  const path = join(dir, name)
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc(height * (width + 1), 0))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
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
  const picked =
    Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "same"
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
  const last: { body?: DecisionsBody; headers?: Headers } = {}
  const seen = {
    get body() {
      return defined(last.body)
    },
    get headers() {
      return defined(last.headers)
    },
  }
  server.use(
    http.post(endpoint, async ({ request }) => {
      const body = (await request.json()) as DecisionsBody
      last.body = body
      last.headers = request.headers
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

beforeEach(() => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", baseUrl)
})

describe("judgeWithJev questions", () => {
  test("asks one question for each area and quality, and skips page-only qualities for a component", async () => {
    const seen = serve(() => fine)
    await judgeWithJev(await story())
    const names = Object.keys(seen.body.questions)
    for (const { id } of areas) expect(names).toContain(`area.${id}`)
    for (const { id, pageOnly } of qualities)
      expect(names.includes(`quality.${id}`)).toBe(!pageOnly)
    expect(seen.body.model).toBe("typesafe/jev-1.14")
    expect(seen.body.questions["defect"]?.type).toBe("noul")
    expect(seen.body.questions["run-together"]).toMatchObject({
      type: "noul",
      instructions: expect.stringContaining("no space and no separator"),
    })
    expect(seen.body.questions["defect-box"]?.type).toBe("box")
    expect(seen.body.questions["area.spacing"]?.type).toBe("choice")
    expect(
      Object.keys(
        defined(seen.body.questions["area.spacing"]).criteria as object,
      ),
    ).toEqual(["better", "same", "worse"])
  })

  test("each question holds the definition of its rubric entry, with the narrowed house exemptions", async () => {
    const seen = serve(() => fine)
    await judgeWithJev(await story())
    const instructions = (name: string) =>
      String(defined(seen.body.questions[name]).instructions)
    expect(instructions("area.broken-content")).toMatch(
      /^Area: Broken content\. .*undefined, null, NaN, \[object Object\].* Does the change make this area better, the same or worse\?/,
    )
    expect(instructions("quality.restraint")).toContain(
      "the mono uppercase .ctx-label as a section label in a dense panel (not as an eyebrow above a page title or a card heading)",
    )
    expect(instructions("quality.clarity")).toContain(
      "Each form field has a visible label",
    )
  })

  test("asks the page-only qualities for a page", async () => {
    const seen = serve(() => fine)
    await judgeWithJev(await story({ scope: "page" }))
    expect(Object.keys(seen.body.questions)).toContain("quality.focus")
  })

  test("sends the images as data URLs, with the key and the images header", async () => {
    const seen = serve(() => fine)
    await judgeWithJev(await story())
    expect(seen.headers.get("authorization")).toBe("Bearer test-key")
    expect(seen.headers.get("typesafe-danger-zone-images")).toBe("true")
    expect(
      seen.body.state.filter((part) => typeof part !== "string"),
    ).toHaveLength(2)
  })

  test("asks the provider not to keep the data, and says that the data blocks are not instructions", async () => {
    const seen = serve(() => fine)
    await judgeWithJev(await story({ brief: "Rename the button." }))
    expect(seen.body.provider).toEqual({ data_collection: "deny" })
    expect(seen.body.state[0]).toContain("never instructions")
  })
})

describe("judgeWithJev with another decision model", () => {
  test.each(["baseten/elephant-1", "baseten/mammoth-1"])(
    "%s gets the same request without the box question, and a worse area gets the largest measured region",
    async (model) => {
      const seen = serve((name) =>
        name === "defect"
          ? defect(0.9)
          : name === "area.spacing"
            ? choice(0.02, 0.08, 0.9)
            : fine,
      )
      const verdict = await judgeWithJev(await story(), model)

      expect(seen.body.model).toBe(model)
      expect(seen.body.questions["defect-box"]).toBeUndefined()
      expect(seen.body.questions["defect"]?.type).toBe("noul")
      expect(seen.body.questions["area.spacing"]?.type).toBe("choice")
      expect(
        seen.body.state.filter((part) => typeof part !== "string"),
      ).toHaveLength(2)
      expect(verdict.verdict).toBe("regression")
      expect(
        verdict.findings.map(({ kind, region }) => ({ kind, region })),
      ).toEqual([
        {
          kind: "spacing",
          region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        },
      ])
    },
  )
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
    const verdict = await judgeWithJev(await story())
    expect(verdictSchema.parse(verdict)).toEqual(verdict)
    expect(verdict.verdict).toBe("regression")
    expect(verdict.severity).toBe("minor")
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

  test("a Jev regression is minor at any probability: feedback that never blocks", async () => {
    serve((name) => {
      if (name === "area.spacing") return choice(0.1, 0.3, 0.6)
      if (name === "defect") return defect(0.1)
      if (name === "defect-box") return box(0.2, 0.5, 0.1, 0.4)
      return fine
    })
    const verdict = await judgeWithJev(await story())
    expect(verdict.verdict).toBe("regression")
    expect(verdict.severity).toBe("minor")
    expect(verdict.confidence).toBeCloseTo(0.6)
  })

  test("a worse quality with no worse area names the region of the box in the summary", async () => {
    serve((name) => {
      if (name === "quality.consistency") return choice(0, 0.2, 0.8)
      if (name === "defect") return defect(0.1)
      if (name === "defect-box") return box(0.2, 0.5, 0.1, 0.4)
      return fine
    })
    const verdict = await judgeWithJev(await story())
    expect(verdict.verdict).toBe("regression")
    expect(verdict.findings).toEqual([])
    expect(verdict.summary).toContain("consistency 0.80")
    expect(verdict.summary).toMatch(
      /Region: x 0\.10, y 0\.20, width 0\.30, height 0\.30\./,
    )
  })

  test("nothing worse is intended when a brief explains the change", async () => {
    serve((name) =>
      name === "defect" || name === "run-together" ? defect(0.03) : fine,
    )
    const verdict = await judgeWithJev(
      await story({ brief: "Rename the button." }),
    )
    expect(verdict.verdict).toBe("intended")
    expect(verdict.severity).toBe("none")
    expect(verdict.findings).toEqual([])
    expect(verdict.confidence).toBeGreaterThan(0.9)
  })

  test("nothing worse without a brief or diff is unsure, as the schema rule says", async () => {
    serve((name) => (name === "defect" ? defect(0.03) : fine))
    const verdict = await judgeWithJev(await story())
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
    )
    expect(verdict.verdict).toBe("unsure")
  })

  test("a refused question makes the verdict unsure, not intended", async () => {
    serve((name) => {
      if (name === "quality.clarity") return { type: "refusal" }
      if (name === "defect" || name === "run-together") return defect(0.03)
      return fine
    })
    const verdict = await judgeWithJev(
      await story({ brief: "Rename the button." }),
    )
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.summary).toContain("1 questions")
    expect(verdict.qualities.map(({ name }) => name)).not.toContain("clarity")
  })

  test("a choice answer with a missing or out-of-range probability counts as no answer", async () => {
    serve((name) => {
      if (name === "area.spacing")
        return { type: "choice", probabilities: { worse: 0 } }
      if (name === "area.contrast")
        return {
          type: "choice",
          probabilities: { better: 0, same: 1.5, worse: 0 },
        }
      if (name === "defect" || name === "run-together") return defect(0.03)
      return fine
    })
    const verdict = await judgeWithJev(
      await story({ brief: "Rename the button." }),
    )
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.summary).toContain("2 questions")
  })

  test("a label that runs two parts together is a spacing finding in the region of the box", async () => {
    serve((name) => {
      if (name === "run-together") return defect(0.86)
      if (name === "defect") return defect(0.1)
      if (name === "defect-box") return box(0.2, 0.3, 0.1, 0.4)
      return fine
    })
    const verdict = await judgeWithJev(
      await story({ brief: "Show the step number before the step name." }),
    )
    expect(verdict.verdict).toBe("regression")
    expect(verdict.severity).toBe("minor")
    expect(verdict.findings.map(({ kind }) => kind)).toEqual(["spacing"])
    expect(verdict.summary).toContain("spacing (parts run together) 0.86")
  })

  test("a worse spacing area and a run-together label give one spacing finding", async () => {
    serve((name) => {
      if (name === "run-together") return defect(0.7)
      if (name === "area.spacing") return choice(0, 0.3, 0.7)
      if (name === "defect") return defect(0.1)
      if (name === "defect-box") return box(0.2, 0.3, 0.1, 0.4)
      return fine
    })
    const verdict = await judgeWithJev(await story())
    expect(verdict.findings.map(({ kind }) => kind)).toEqual(["spacing"])
  })

  test("a run-together answer under 0.5 does not make the verdict unsure", async () => {
    serve((name) => {
      if (name === "run-together") return defect(0.45)
      if (name === "defect") return defect(0.03)
      return fine
    })
    const verdict = await judgeWithJev(
      await story({ brief: "Rename the button." }),
    )
    expect(verdict.verdict).toBe("intended")
  })

  test("the caller can keep the raw answers of Jev", async () => {
    serve((name) => (name === "run-together" ? defect(0.2) : fine))
    let kept: Record<string, unknown> | undefined
    await judgeWithJev(await story(), undefined, (answers) => {
      kept = answers
    })
    expect(kept?.["run-together"]).toEqual(defect(0.2))
    expect(kept?.["area.spacing"]).toEqual(fine)
  })

  test("a response with no answers is unsure, not intended", async () => {
    serve(() => undefined)
    const verdict = await judgeWithJev(
      await story({ brief: "Rename the button." }),
    )
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.confidence).toBe(0)
    expect(verdict.qualities).toEqual([])
  })

  test("a flagged defect that no area names stays unsure, with no finding", async () => {
    serve((name) => {
      if (name === "defect") return defect(0.8)
      if (name === "defect-box") return box(0.5, 0.6, 0.5, 0.6)
      return fine
    })
    const verdict = await judgeWithJev(await story())
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.severity).toBe("none")
    expect(verdict.findings).toEqual([])
    expect(verdict.summary).toContain("cannot place it")
  })

  test("a worse quality is a regression with no finding", async () => {
    serve((name) => (name === "quality.restraint" ? choice(0, 0.1, 0.9) : fine))
    const verdict = await judgeWithJev(await story())
    expect(verdict.verdict).toBe("regression")
    expect(verdict.severity).toBe("minor")
    expect(verdict.findings).toEqual([])
    expect(verdict.summary).toContain("restraint")
  })

  test("a worse area with no usable box is unsure, not a guessed region", async () => {
    const seen = serve((name) => {
      if (name === "area.contrast") return choice(0, 0.1, 0.9)
      if (name === "defect") return defect(0.9)
      return fine
    })
    const verdict = await judgeWithJev(
      await story({
        images: [{ role: "regions", path: await png("r.png", 600, 300) }],
      }),
    )
    expect(Object.keys(seen.body.questions)).not.toContain("defect-box")
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.findings).toEqual([])
  })

  test("a box with no area or no extent is not a region", async () => {
    serve((name) => {
      if (name === "area.contrast") return choice(0, 0.1, 0.9)
      if (name === "defect") return defect(0.9)
      if (name === "defect-box") return box(0.5, 0.5, 0.2, 0.4)
      return fine
    })
    const verdict = await judgeWithJev(await story())
    expect(verdict.verdict).toBe("unsure")
  })
})

describe("judgeWithJev images", () => {
  const countCalls = () => {
    const calls = { count: 0 }
    server.use(
      http.post(endpoint, () => {
        calls.count += 1
        return HttpResponse.json({ model: "typesafe/jev-1.14", answers: {} })
      }),
    )
    return calls
  }

  const sentImages = (body: DecisionsBody) =>
    body.state.flatMap((part) =>
      typeof part === "string"
        ? []
        : [Buffer.from(part.image_url.url.split(",")[1] ?? "", "base64")],
    )

  test.each([
    ["a side under 280 px", 279, 400, 280, 400],
    ["a side over 1568 px", 400, 1569, 400, 1568],
  ])(
    "%s is padded or scaled to fit, and the call is made",
    async (_, width, height, sentWidth, sentHeight) => {
      const seen = serve(() => fine)
      const path = await png(`bad-${width}x${height}.png`, width, height)
      const verdict = await judgeWithJev(
        await story({
          images: [
            { role: "regions", path: await png("ok.png", 400, 400) },
            { role: "locator", path },
          ],
        }),
      )
      expect(verdict.error).toBeUndefined()
      const [, locator] = sentImages(seen.body)
      const size = decode(defined(locator))
      expect({ width: size.width, height: size.height }).toEqual({
        width: sentWidth,
        height: sentHeight,
      })
    },
  )

  test("a box on a padded locator is mapped back to fractions of the picture", async () => {
    // The locator is 400 x 200 px, padded to 400 x 280 px: the picture holds
    // 5/7 of the height.
    const seen = serve((name) => {
      if (name === "area.spacing") return choice(0, 0.05, 0.95)
      if (name === "defect") return defect(0.92)
      if (name === "defect-box") return box(0.1, 5 / 7 / 2, 0.2, 0.6)
      return fine
    })
    const verdict = await judgeWithJev(
      await story({
        images: [{ role: "locator", path: await png("short.png", 400, 200) }],
      }),
    )
    expect(verdictSchema.parse(verdict)).toEqual(verdict)
    expect(seen.body.questions["defect-box"]?.type).toBe("box")
    const region = defined(verdict.findings[0]).region
    expect(region.x).toBeCloseTo(0.2)
    expect(region.width).toBeCloseTo(0.4)
    expect(region.y).toBeCloseTo(0.14)
    expect(region.height).toBeCloseTo(0.36)
  })

  test("a file that is not a PNG gives unsure and makes no call", async () => {
    const calls = countCalls()
    const path = join(dir, "not-a-png.png")
    await writeFile(path, "plain text, not an image at all")
    const verdict = await judgeWithJev(
      await story({ images: [{ role: "after", path }] }),
    )
    expect(calls.count).toBe(0)
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.error).toContain("not a PNG")
    expect(verdict.error).toContain(path)
  })

  test("sides of exactly 280 and 1568 px go through, with the bytes as they are", async () => {
    const seen = serve(() => fine)
    const small = await png("edge-small.png", 280, 280)
    const large = await png("edge-large.png", 1568, 1568)
    const verdict = await judgeWithJev(
      await story({
        images: [
          { role: "regions", path: small },
          { role: "after", path: large },
        ],
      }),
    )
    expect(verdict.error).toBeUndefined()
    const urls = seen.body.state.flatMap((part) =>
      typeof part === "string" ? [] : [part.image_url.url],
    )
    expect(urls).toEqual(
      await Promise.all(
        [small, large].map(
          async (path) =>
            `data:image/png;base64,${(await readFile(path)).toString("base64")}`,
        ),
      ),
    )
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
    const verdict = await judgeWithJev(await story())
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
    await expect(judgeWithJev(await story())).rejects.toThrow(/429.*Slow down/)
  })

  test("an unknown cost is null", async () => {
    serve(() => fine, { input_tokens: 10, output_tokens: 1 })
    const verdict = await judgeWithJev(await story())
    expect(verdict.costUsd).toBeNull()
  })

  test("without a key it throws before any request", async () => {
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "")
    await expect(judgeWithJev(await story())).rejects.toThrow(
      /MODEL_PROVIDER_API_KEY/,
    )
  })
})

describe("judgeNewWithJev", () => {
  const newStory = async (brief?: string) => ({
    storyId: "connectors-card--new",
    scope: "component" as const,
    images: [
      {
        path: await png("new.png", 800, 500),
        size: { width: 800, height: 500 },
      },
    ],
    ...(brief ? { brief } : {}),
  })
  const noul = (value: number) => ({ type: "noul", noul: value })

  test("asks whether the screenshot breaks a rule, with no change and a box only for Jev 1.14", async () => {
    const seen = serve(() => noul(0.02))
    await judgeNewWithJev(await newStory())
    const { questions, state } = seen.body
    expect(Object.keys(questions)).toEqual([
      "defect",
      ...areas.map(({ id }) => `area.${id}`),
      ...qualities
        .filter(({ pageOnly }) => !pageOnly)
        .map(({ id }) => `quality.${id}`),
      "defect-box",
    ])
    expect(
      Object.entries(questions)
        .filter(([name]) => name !== "defect-box")
        .every(([, { type }]) => type === "noul"),
    ).toBe(true)
    expect(JSON.stringify(questions)).not.toMatch(/better, the same or worse/)
    expect(state).toContain("Image 1 (after):")

    const other = serve(() => noul(0.02))
    await judgeNewWithJev(await newStory(), "baseten/elephant-1")
    expect(Object.keys(other.body.questions)).not.toContain("defect-box")
  })

  test("a broken area is a regression in the region of the box", async () => {
    serve((name) => {
      if (name === "area.spacing") return noul(0.9)
      if (name === "defect") return noul(0.85)
      if (name === "defect-box") return box(0.2, 0.5, 0.1, 0.4)
      return noul(0.02)
    })
    const verdict = await judgeNewWithJev(await newStory())
    expect(verdictSchema.parse(verdict)).toEqual(verdict)
    expect(verdict.verdict).toBe("regression")
    expect(verdict.severity).toBe("minor")
    expect(verdict.findings.map(({ kind }) => kind)).toEqual(["spacing"])
    expect(verdict.findings[0]?.region.x).toBeCloseTo(0.1)
    expect(verdict.findings[0]?.region.height).toBeCloseTo(0.3)
    expect(verdict.qualities.every(({ delta }) => delta === "meets")).toBe(true)
  })

  test("broken content, such as a raw undefined, is a regression of its own kind", async () => {
    const seen = serve((name) => {
      if (name === "area.broken-content") return noul(0.88)
      if (name === "defect") return noul(0.9)
      if (name === "defect-box") return box(0.6, 0.7, 0.2, 0.5)
      return noul(0.02)
    })
    const verdict = await judgeNewWithJev(await newStory())
    expect(
      String(defined(seen.body.questions["area.broken-content"]).instructions),
    ).toMatch(/Does the new screenshot break a rule of this area\?$/)
    expect(verdictSchema.parse(verdict)).toEqual(verdict)
    expect(verdict.verdict).toBe("regression")
    expect(verdict.findings.map(({ kind }) => kind)).toEqual(["broken-content"])
    expect(verdict.findings[0]?.rubricRef).toBe(
      ".agents/skills/product-ui/references/visual-craft.md › Finishing",
    )
  })

  test("another decision model places a finding on the whole image", async () => {
    serve((name) => (name === "area.spacing" ? noul(0.7) : noul(0.02)))
    const verdict = await judgeNewWithJev(await newStory(), "baseten/mammoth-1")
    expect(verdict.verdict).toBe("regression")
    expect(verdict.severity).toBe("minor")
    expect(verdict.findings[0]?.region).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    })
  })

  test("a failed quality is a regression with a fails rating", async () => {
    serve((name) => (name === "quality.clarity" ? noul(0.6) : noul(0.02)))
    const verdict = await judgeNewWithJev(await newStory())
    expect(verdict.verdict).toBe("regression")
    expect(verdict.findings).toEqual([])
    expect(verdict.qualities).toContainEqual({
      name: "clarity",
      delta: "fails",
      confidence: 0.6,
    })
  })

  test("nothing broken is intended with a brief, and unsure without one", async () => {
    serve(() => noul(0.02))
    expect(
      (await judgeNewWithJev(await newStory("Add the card."))).verdict,
    ).toBe("intended")
    expect((await judgeNewWithJev(await newStory())).verdict).toBe("unsure")
  })

  test("a doubtful, a missing or an unplaced answer is unsure, not intended", async () => {
    serve((name) => (name === "quality.hierarchy" ? noul(0.3) : noul(0.02)))
    expect(
      (await judgeNewWithJev(await newStory("Add the card."))).verdict,
    ).toBe("unsure")
    serve((name) => (name === "area.spacing" ? {} : noul(0.02)))
    expect(
      (await judgeNewWithJev(await newStory("Add the card."))).verdict,
    ).toBe("unsure")
    // A broken area with no usable box has no region: unsure.
    serve((name) =>
      name === "area.spacing"
        ? noul(0.9)
        : name === "defect-box"
          ? {}
          : noul(0.02),
    )
    const unplaced = await judgeNewWithJev(await newStory("Add the card."))
    expect(unplaced.verdict).toBe("unsure")
    expect(unplaced.findings).toEqual([])
  })

  test("a 400 answer is unsure with the error, and a file that is not a PNG makes no call", async () => {
    server.use(
      http.post(endpoint, () =>
        HttpResponse.json({ error: "bad" }, { status: 400 }),
      ),
    )
    const refused = await judgeNewWithJev(await newStory())
    expect(refused.verdict).toBe("unsure")
    expect(refused.error).toMatch(/400/)

    const text = join(dir, "not-a-png.png")
    await writeFile(text, "text")
    const story = await newStory()
    const verdict = await judgeNewWithJev({
      ...story,
      images: [{ path: text, size: { width: 1, height: 1 } }],
    })
    expect(verdict.verdict).toBe("unsure")
    expect(verdict.error).toMatch(/not a PNG/)
  })
})
