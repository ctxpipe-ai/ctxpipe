// The whole path of one visual run, with the real compare engine, the real
// image files and the real Jev adapter. Only the provider HTTP is faked.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

import { screenshot } from "./compare/fixtures.ts"
import {
  diff,
  judgeWithJev,
  packagedRubric,
  reviewStories,
  toStoryInput,
  writeStoryImages,
  type Manifest,
  type ManifestStory,
  type StoryInput,
} from "./index.ts"

const endpoint = "https://openrouter.test/api/alpha/decisions"

type Request = { questions: Record<string, unknown>; state: unknown[] }
const requests: Request[] = []

const server = setupServer(
  http.post(endpoint, async ({ request }) => {
    const body = (await request.json()) as Request
    requests.push(body)
    return HttpResponse.json({
      model: "typesafe/jev-1.14",
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([name, question]) => [
          name,
          (question as { type: string }).type === "noul"
            ? { type: "noul", noul: 0.01 }
            : {
                type: "choice",
                probabilities: { better: 0.02, same: 0.97, worse: 0.01 },
              },
        ]),
      ),
      usage: { cost: 0.003 },
    })
  }),
)
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterAll(() => server.close())
beforeEach(() => {
  requests.length = 0
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://openrouter.test/api/v1")
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visual-critic-"))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

// A wide page where a shared badge changes color in each story.
async function ripple(count: number): Promise<StoryInput[]> {
  const before = screenshot(3000, 400, [
    { box: { x: 100, y: 100, width: 1500, height: 60 }, color: [17, 17, 17] },
  ])
  const after = screenshot(3000, 400, [
    { box: { x: 100, y: 100, width: 1500, height: 60 }, color: [220, 38, 38] },
  ])
  const comparison = await diff(before, after)
  if (comparison.status !== "changed") throw new Error(comparison.status)
  const stories: ManifestStory[] = []
  for (let i = 0; i < count; i++) {
    const id = `badge-ripple--story-${i}`
    const { images, omittedRegions } = await writeStoryImages(
      { root, dir: id },
      before,
      after,
      comparison,
    )
    stories.push({
      id,
      title: "Badge ripple",
      componentFile: `apps/ui/src/Story${i}.stories.tsx`,
      scope: "component",
      viewport: "desktop",
      snapshot: null,
      baseline: `apps/ui/src/screenshots/Story${i}.Default.desktop.screenshot.png`,
      status: "changed",
      maxDiffPixels: 10,
      size: comparison.size,
      diffPixels: comparison.diffPixels,
      regions: comparison.regions,
      severity: comparison.severity,
      summary: comparison.summary,
      signature: comparison.signature,
      omittedRegions,
      images,
    })
  }
  const manifest: Manifest = {
    version: 1,
    run: {
      imageDigest: null,
      playwrightVersion: "1.58.0",
      viewports: {
        desktop: { width: 1440, height: 900 },
        mobile: { width: 390, height: 844 },
      },
      threshold: 0.1,
      commit: "abc123",
      baseRef: null,
    },
    stories,
  }
  return stories.map((story) =>
    toStoryInput(manifest, story, {
      root,
      brief: "Make the badge red.",
      rubric: packagedRubric,
    }),
  )
}

describe("the critic path", () => {
  test("a 30-story ripple of one shared component is 3 requests, and every image sent fits the model limits", async () => {
    const stories = await ripple(30)

    const verdicts = await reviewStories(stories, judgeWithJev)

    expect(requests).toHaveLength(3)
    expect(verdicts).toHaveLength(30)
    expect(verdicts.filter(({ groupedWith }) => groupedWith)).toHaveLength(27)
    expect(verdicts.every(({ verdict }) => verdict === "intended")).toBe(true)
    for (const request of requests) {
      const urls = request.state.flatMap((part) =>
        typeof part === "string"
          ? []
          : [(part as { image_url: { url: string } }).image_url.url],
      )
      expect(urls.length).toBeGreaterThan(0)
      for (const url of urls) {
        const { width, height } = decode(
          Buffer.from(url.split(",")[1] ?? "", "base64"),
        )
        expect(width).toBeGreaterThanOrEqual(280)
        expect(width).toBeLessThanOrEqual(1568)
        expect(height).toBeGreaterThanOrEqual(280)
        expect(height).toBeLessThanOrEqual(1568)
      }
    }
  })

  test("a story with only rendering noise makes no request", async () => {
    const [story] = await ripple(1)
    if (!story) throw new Error("No story.")

    const verdicts = await reviewStories(
      [
        {
          ...story,
          regions: story.regions.map((region) => ({
            ...region,
            changeType: "rendering-noise" as const,
          })),
        },
      ],
      judgeWithJev,
    )

    expect(requests).toHaveLength(0)
    expect(verdicts[0]).toMatchObject({ verdict: "noise", costUsd: 0 })
  })
})
