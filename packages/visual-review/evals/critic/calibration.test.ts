// The owner calibration on two small screenshots, with msw in place of
// OpenRouter and of the Jev Decisions API.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"

import { screenshot } from "../../src/compare/fixtures.ts"
import { packagedRubric } from "../../src/rubric.ts"
import {
  calibrate,
  calibrationSchema,
  type Calibration,
} from "./calibration.ts"
import { imageFile, sha256Of } from "./images.ts"

const gateway = "https://gateway.test/api/v1"
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

const dir = mkdtempSync(join(tmpdir(), "calibration-test-"))
const images = join(dir, "images")
mkdirSync(images)
const store = (gray: number) => {
  const bytes = screenshot(400, 300, [
    {
      box: { x: 40, y: 40, width: 120, height: 30 },
      color: [gray, gray, gray],
    },
  ])
  const sha256 = sha256Of(bytes)
  writeFileSync(join(images, imageFile(sha256)), bytes)
  return sha256
}
const calibration: Calibration = {
  date: "2026-11-14",
  screenshots: [
    {
      path: "apps/ui/src/a.png",
      image: store(100),
      storyId: "pages-a--story",
      scope: "page",
      flag: [
        { issue: "Status words in many colors.", kinds: ["color-tokens"] },
        { issue: "The add action is a lone icon.", kinds: ["clarity"] },
      ],
      ok: [
        // Shares `color-tokens` with an issue: a flag of it is a hit only.
        { item: "The red error.", kinds: ["color-tokens"] },
        { item: "The heatmap.", kinds: ["density"] },
      ],
    },
    {
      path: "apps/ui/src/b.png",
      image: store(200),
      storyId: "components-b--story",
      scope: "component",
      flag: [],
      ok: [{ item: "Partial UI.", kinds: ["missing-elements"] }],
    },
  ],
}
const calibrationPath = join(dir, "calibration.json")
writeFileSync(calibrationPath, JSON.stringify(calibration))

// The LLM flags color-tokens (a finding) and density (a failed quality) on
// every screenshot.
const judgment = {
  observations: [{ part: 1, seen: "A list of rows." }],
  verdict: "regression",
  severity: "minor",
  confidence: 0.8,
  summary: "The status words have many colors.",
  qualities: [{ name: "density", rating: "fails", confidence: 0.7 }],
  findings: [
    {
      kind: "color-tokens",
      region: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      evidence: "Green, red and gray status words.",
      rubricRef: "apps/ui/DESIGN.md › Color",
      explainedByBrief: false,
      suggestion: null,
    },
  ],
}

test("counts the owner issues and the fine items that each arm flags", async () => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", gateway)
  server.use(
    http.post(`${gateway}/chat/completions`, () =>
      HttpResponse.json({
        choices: [{ message: { content: JSON.stringify(judgment) } }],
        usage: { cost: 0.01 },
      }),
    ),
    // Jev says that each screenshot breaks only the clarity quality.
    http.post(
      "https://gateway.test/api/alpha/decisions",
      async ({ request }) => {
        const { questions } = (await request.json()) as {
          questions: Record<string, { type: string }>
        }
        const answers = Object.fromEntries(
          Object.entries(questions).map(([name, { type }]) => [
            name,
            type === "box"
              ? { type, box: { top: 0.1, bottom: 0.3, left: 0.1, right: 0.4 } }
              : { type, noul: name === "quality.clarity" ? 0.9 : 0.05 },
          ]),
        )
        return HttpResponse.json({
          model: "typesafe/jev-1.14",
          answers,
          usage: { cost: 0.0005 },
        })
      },
    ),
  )
  const out = join(dir, "out")
  let printed = ""

  const code = await calibrate(
    [
      "--arms",
      "jev,llm:anthropic/claude-sonnet-5.5",
      "--calibration",
      calibrationPath,
      "--images",
      images,
      "--out",
      out,
    ],
    (text) => (printed += text),
  )

  expect(code).toBe(0)
  // The LLM: on the first screenshot, a hit (color-tokens) and a false flag
  // (density). On the second, nothing that the owner named.
  expect(printed).toContain(
    "| llm:anthropic/claude-sonnet-5.5 | 2 | 1 / 2 | 1 / 3 | 2 | 0 |",
  )
  // Jev: a hit (clarity) and no false flag.
  expect(printed).toContain("| jev | 2 | 1 / 2 | 0 / 3 | 2 | 0 |")
  expect(printed).toContain(
    "| pages-a--story | 1 / 2 hits, 0 / 2 false (clarity) | 1 / 2 hits, 1 / 2 false (color-tokens, density) |",
  )
  const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"))
  expect(results.results).toHaveLength(4)
  expect(results.spent).toBeCloseTo(0.021)
})

test("an arm that judges no new screenshot is a usage error, with no call", async () => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  let printed = ""

  const code = await calibrate(["--arms", "nope"], (text) => (printed += text))

  expect(code).toBe(2)
  expect(printed).toContain('Unknown arm "nope"')
})

test("the owner calibration of 2026-11-14 matches the schema", () => {
  const committed = calibrationSchema.parse(
    JSON.parse(
      readFileSync(join(import.meta.dirname, "owner-calibration.json"), "utf8"),
    ),
  )

  expect(committed.screenshots).toHaveLength(10)
  // Each kind is an id of the rubric, so that a judge can flag it.
  const ids = new Set(
    [...packagedRubric.areas, ...packagedRubric.qualities].map(({ id }) => id),
  )
  const kinds = committed.screenshots.flatMap(({ flag, ok }) =>
    [...flag, ...ok].flatMap(({ kinds }) => kinds),
  )
  expect(kinds.filter((kind) => !ids.has(kind))).toEqual([])
})
