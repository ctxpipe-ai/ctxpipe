import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { z } from "zod"

import {
  createKnowledgeStore,
  type KnowledgeScope,
  type KnowledgeStore,
} from "../knowledge-store/knowledge-store.js"
import { startClickHouse } from "../test/clickhouse.js"
import {
  IMAGE_TEXT_PROMPT_VERSION,
  type ImageReading,
  type ImageTextCounter,
  imageTexts,
} from "./image-text.js"

/*
 * The image-text cache (CTX-1433) against a real ClickHouse of the pinned
 * image. msw answers the vision model and counts its calls. The ClickHouse
 * requests pass through msw.
 */

const BASE = "https://openrouter.test/api/v1"
const scope: KnowledgeScope = { orgId: "org_image_cache", workspaceId: "ws_1" }

const reading = (label: string): ImageReading => ({
  description: `A diagram of ${label}.`,
  text: label,
  diagram: {
    kind: "graph",
    direction: "LR",
    groups: [],
    nodes: [
      { id: "a", label, group: "" },
      { id: "b", label: "Database", group: "" },
    ],
    edges: [{ from: "a", to: "b", label: "SQL", arrow: "forward" }],
    participants: [],
    messages: [],
  },
})

/** The label of the image, from its bytes: each test image is a label. */
const visionCalls: { model: string; label: string }[] = []
let answer: (model: string) => {
  status: number
  model?: string
} = (model) => ({ status: 200, model })
const msw = setupServer(
  http.post(`${BASE}/chat/completions`, async ({ request }) => {
    const body = z
      .object({ model: z.string(), messages: z.array(z.unknown()) })
      .parse(await request.json())
    const label = Buffer.from(
      JSON.stringify(body.messages).match(/base64,([A-Za-z0-9+/=]+)/)?.[1] ??
        "",
      "base64",
    ).toString()
    visionCalls.push({ model: body.model, label })
    const { status, model } = answer(body.model)
    if (status !== 200)
      return HttpResponse.json({ error: { message: "no" } }, { status })
    return HttpResponse.json({
      model,
      provider: "Azure",
      choices: [{ message: { content: JSON.stringify(reading(label)) } }],
      usage: { cost: 0.005 },
    })
  }),
)

let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
let store: KnowledgeStore

beforeAll(async () => {
  msw.listen({ onUnhandledRequest: "bypass" })
  clickHouse = await startClickHouse()
}, 240_000)

afterAll(async () => {
  msw.close()
  await clickHouse?.stop()
})

beforeEach(async () => {
  vi.stubEnv("MODEL_PROVIDER", "openrouter")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", BASE)
  store = createKnowledgeStore(await clickHouse.freshDatabase())
  visionCalls.length = 0
  answer = (model) => ({ status: 200, model })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await store.close()
})

const image = (label: string) => ({
  bytes: Buffer.from(label),
  mimeType: "image/png",
})
const counter = (): ImageTextCounter => ({
  hits: 0,
  misses: 0,
  failures: 0,
  costUsd: 0,
})
const run = (
  images: { blobSha: string; label: string; labels?: string }[],
  count = counter(),
) =>
  imageTexts({
    store,
    scope,
    images: images.map(({ blobSha, label, labels }) => ({
      blobSha,
      image: image(label),
      labels,
    })),
    counter: count,
    backoffMs: 1,
  })

describe("imageTexts", () => {
  it("reads each blob once, and a second run makes no vision call", async () => {
    const images = [
      { blobSha: "sha-api", label: "API" },
      { blobSha: "sha-api", label: "API" },
      { blobSha: "sha-queue", label: "Queue" },
    ]
    const first = counter()
    const texts = await run(images, first)
    expect(visionCalls.map((call) => call.label)).toEqual(["API", "Queue"])
    // MODEL_VISION_NAME is not set: the default model reads.
    expect(visionCalls[0]?.model).toBe("openai/gpt-6.1-terra")
    expect(first).toEqual({ hits: 0, misses: 2, failures: 0, costUsd: 0.01 })
    expect(texts.get("sha-api")).toEqual({
      text: expect.stringContaining('n1["API"]'),
    })

    const second = counter()
    expect(await run(images, second)).toEqual(texts)
    expect(visionCalls).toHaveLength(2)
    expect(second).toEqual({ hits: 2, misses: 0, failures: 0, costUsd: 0 })
  })

  it("reads with the model of MODEL_VISION_NAME and caches under it; another model reads again", async () => {
    vi.stubEnv("MODEL_VISION_NAME", " vendor/custom ")
    // The answer names the model in a dated form: the cache key is the
    // model of the request.
    answer = (model) => ({ status: 200, model: `${model}-2026-11-01` })
    await run([{ blobSha: "sha-1", label: "Cache" }])
    expect(visionCalls.map((call) => call.model)).toEqual(["vendor/custom"])
    const stored = await store.readImageTexts(
      scope,
      ["sha-1"],
      "vendor/custom",
      IMAGE_TEXT_PROMPT_VERSION,
    )
    expect(stored.get("sha-1")?.model).toBe("vendor/custom")
    await run([{ blobSha: "sha-1", label: "Cache" }])
    expect(visionCalls).toHaveLength(1)

    // A change of the model gives a new entry and keeps the old one.
    vi.stubEnv("MODEL_VISION_NAME", "vendor/other")
    await run([{ blobSha: "sha-1", label: "Cache" }])
    expect(visionCalls.map((call) => call.model)).toEqual([
      "vendor/custom",
      "vendor/other",
    ])
    expect(
      (
        await store.readImageTexts(
          scope,
          ["sha-1"],
          "vendor/custom",
          IMAGE_TEXT_PROMPT_VERSION,
        )
      ).size,
    ).toBe(1)
  })

  it("refuses a MODEL_VISION_NAME of only spaces before it calls a model", async () => {
    vi.stubEnv("MODEL_VISION_NAME", "   ")
    await expect(run([{ blobSha: "sha-1", label: "Cache" }])).rejects.toThrow(
      "MODEL_VISION_NAME must name one OpenRouter model",
    )
    expect(visionCalls).toHaveLength(0)
  })

  it("gives a failed reading its error, caches nothing, and tries again on the next run", async () => {
    answer = () => ({ status: 400 })
    const failed = counter()
    const texts = await run([{ blobSha: "sha-bad", label: "Bad" }], failed)
    expect(texts.get("sha-bad")).toEqual({
      error: "The vision model answered 400.",
    })
    expect(failed.failures).toBe(1)

    answer = (model) => ({ status: 200, model })
    expect(
      (await run([{ blobSha: "sha-bad", label: "Bad" }])).get("sha-bad"),
    ).toEqual({ text: expect.stringContaining("Bad") })
    expect(visionCalls).toHaveLength(2)
  })

  it("stops the run on an outage of the vision model, so that the retry reads the image again", async () => {
    answer = () => ({ status: 503 })
    await expect(
      run([{ blobSha: "sha-down", label: "Down" }]),
    ).rejects.toMatchObject({
      kind: "http",
      status: 503,
    })
    expect(visionCalls).toHaveLength(3)
  })

  it("adds the labels of an SVG to its text", async () => {
    const texts = await run([
      { blobSha: "sha-svg", label: "Diagram", labels: "Orders\nPayments\n" },
    ])
    expect(texts.get("sha-svg")).toEqual({
      text: expect.stringMatching(/Labels in the file:\nOrders\nPayments\n$/),
    })
  })
})
