// The calibration on small screenshots of both sets (the owner examples and
// the unseen set), with msw in place of OpenRouter and of the Jev Decisions
// API.
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
  type Unseen,
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
      round: 1,
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
      round: 2,
      flag: [],
      ok: [{ item: "Partial UI.", kinds: ["missing-elements"] }],
    },
  ],
}
const calibrationPath = join(dir, "calibration.json")
writeFileSync(calibrationPath, JSON.stringify(calibration))
const votes = (label: "defect" | "fine" | null) => ({
  label,
  votes: [{ model: "vendor-a/judge", label: label ?? "fine", reason: "." }],
})
const unseenShot = (id: string, gray: number) => ({
  id,
  source: "main" as const,
  path: `apps/ui/src/${id}.png`,
  commit: "a".repeat(40),
  image: store(gray),
  scope: "page" as const,
  viewport: "mobile" as const,
})
const unseen: Unseen = {
  selected: "2026-11-15",
  panelModels: ["vendor-a/judge"],
  screenshots: [
    { ...unseenShot("unseen-defect", 30), panel: votes("defect") },
    { ...unseenShot("unseen-fine", 40), panel: votes("fine") },
    // No agreement, and no panel run: neither one runs.
    { ...unseenShot("unseen-disputed", 50), panel: votes(null) },
    unseenShot("unseen-unjudged", 70),
  ],
}
const unseenPath = join(dir, "unseen.json")
writeFileSync(unseenPath, JSON.stringify(unseen))
const noUnseen = join(dir, "no-unseen.json")
writeFileSync(
  noUnseen,
  JSON.stringify({
    ...unseen,
    screenshots: [unseenShot("unseen-unjudged", 70)],
  }),
)

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
      "--unseen",
      noUnseen,
      "--images",
      images,
      "--out",
      out,
    ],
    (text) => (printed += text),
  )

  expect(code).toBe(0)
  // The LLM: on the first screenshot, a hit (color-tokens) and a false flag
  // (density). On the second, nothing that the owner named. The unseen set
  // has no panel label yet, so it has no verdict and no unseen score.
  expect(printed).toContain(
    "| llm:anthropic/claude-sonnet-5.5 (incomplete) | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 2 | 1 / 3 | 2 / 2 | 0 |",
  )
  // Jev: a hit (clarity) and no false flag.
  expect(printed).toContain(
    "| jev (incomplete) | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 2 | 0 / 3 | 2 / 2 | 0 |",
  )
  expect(printed).toContain(
    "Unseen set: 0 of 1 screenshots have a panel label (0 defect, 0 fine). 0 without agreement and 1 with no panel run do not count.",
  )
  expect(printed).toContain(
    "| 1 | pages-a--story | 1 / 2 hits, 0 / 2 false (clarity) | 1 / 2 hits, 1 / 2 false (color-tokens, density) |",
  )
  const results = JSON.parse(
    readFileSync(join(out, "runner", "results.json"), "utf8"),
  )
  expect(results.results).toHaveLength(4)
  expect(results.spent).toBeCloseTo(0.021)
})

test("a screenshot with a before image is a change with its brief, and a worse quality is a hit", async () => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", gateway)
  const change: Calibration = {
    date: "2026-11-14",
    screenshots: [
      {
        path: "apps/ui/src/c.png",
        image: store(220),
        storyId: "components-c--story",
        scope: "component",
        round: 4,
        before: { image: store(60), brief: "Put the markers on one axis." },
        flag: [{ issue: "The nesting is gone.", kinds: ["hierarchy"] }],
        ok: [{ item: "The status dots.", kinds: ["status"] }],
      },
    ],
  }
  const path = join(dir, "change.json")
  writeFileSync(path, JSON.stringify(change))
  const prompts: string[] = []
  server.use(
    http.post(`${gateway}/chat/completions`, async ({ request }) => {
      prompts.push(JSON.stringify(await request.json()))
      return HttpResponse.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                observations: [
                  { region: 1, before: "A framed list.", after: "Bare rows." },
                ],
                verdict: "regression",
                severity: "major",
                confidence: 0.8,
                summary: "The child list lost its frame.",
                qualities: [
                  { name: "hierarchy", delta: "worse", confidence: 0.8 },
                ],
                findings: [],
              }),
            },
          },
        ],
        usage: { cost: 0.01 },
      })
    }),
  )
  const out = join(dir, "out-change")
  let printed = ""

  const code = await calibrate(
    [
      "--arms",
      "llm:anthropic/claude-sonnet-5.5",
      "--calibration",
      path,
      "--unseen",
      noUnseen,
      "--images",
      images,
      "--out",
      out,
    ],
    (text) => (printed += text),
  )

  expect(code).toBe(0)
  // The judge got the change with its brief, not a new screenshot.
  expect(prompts.join("\n")).toContain("Put the markers on one axis.")
  expect(printed).toContain(
    "| llm:anthropic/claude-sonnet-5.5 (incomplete) | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 | 0 / 1 | 1 / 1 | 0 |",
  )
  expect(printed).toContain(
    "| 4 | components-c--story (change) | 1 / 1 hits, 0 / 1 false (hierarchy) |",
  )
})

test("reports the unseen set beside the owner examples, and runs only the unseen screenshots with a panel label", async () => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", gateway)
  const stories: string[] = []
  // The LLM calls each screenshot a regression.
  server.use(
    http.post(`${gateway}/chat/completions`, async ({ request }) => {
      const body = (await request.json()) as {
        messages: { content: { text?: string }[] }[]
      }
      stories.push(
        /Story: (\S+)/.exec(body.messages[0]?.content[1]?.text ?? "")?.[1] ??
          "",
      )
      return HttpResponse.json({
        choices: [{ message: { content: JSON.stringify(judgment) } }],
        usage: { cost: 0.01 },
      })
    }),
  )
  const out = join(dir, "out-unseen")
  let printed = ""

  const code = await calibrate(
    [
      "--arms",
      "llm:anthropic/claude-sonnet-5.5",
      "--calibration",
      calibrationPath,
      "--unseen",
      unseenPath,
      "--images",
      images,
      "--out",
      out,
    ],
    (text) => (printed += text),
  )

  expect(code).toBe(0)
  expect(stories.sort()).toEqual([
    "components-b--story",
    "pages-a--story",
    "unseen-defect",
    "unseen-fine",
  ])
  // Unseen: the defect is flagged (recall 1 of 1), and so is the fine
  // screenshot (a false alarm, 1 of 1). Owner: as in the first test.
  expect(printed).toContain(
    "| llm:anthropic/claude-sonnet-5.5 | 1 / 1 | 1 / 1 | 0 / 2 | 1 / 2 | 1 / 3 | 2 / 2 | 0 |",
  )
  expect(printed).toContain(
    "Unseen set: 2 of 4 screenshots have a panel label (1 defect, 1 fine). 1 without agreement and 1 with no panel run do not count.",
  )
  expect(printed).toContain("| unseen-defect | main | defect | regression |")
  expect(printed).toContain("| unseen-fine | main | fine | regression |")
  expect(printed).not.toContain("| unseen-disputed |")
})

test("a run that the spend cap stops marks the unseen scores incomplete", async () => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", gateway)
  let printed = ""

  const code = await calibrate(
    [
      "--arms",
      "llm:anthropic/claude-sonnet-5.5",
      "--calibration",
      calibrationPath,
      "--unseen",
      unseenPath,
      "--images",
      images,
      "--out",
      join(dir, "out-stopped"),
      "--max-cost",
      "0",
    ],
    (text) => (printed += text),
  )

  expect(code).toBe(0)
  expect(printed).toContain("The run stopped early (cost).")
  expect(printed).toContain(
    "| llm:anthropic/claude-sonnet-5.5 (incomplete) | 0 / 0 | 0 / 0 | 0 / 0 |",
  )
})

test("an id in both sets is an input error, with no call", async () => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  const both = join(dir, "both.json")
  writeFileSync(
    both,
    JSON.stringify({
      ...unseen,
      screenshots: [
        { ...unseenShot("pages-a--story", 30), panel: votes("fine") },
      ],
    }),
  )
  let printed = ""

  const code = await calibrate(
    ["--arms", "jev", "--calibration", calibrationPath, "--unseen", both],
    (text) => (printed += text),
  )

  expect(code).toBe(2)
  expect(printed).toContain("The two sets both have the id pages-a--story.")
})

test("an unknown arm is an error of the runner, with no call", async () => {
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

  expect(committed.screenshots).toHaveLength(22)
  // Each kind is an id of the rubric, so that a judge can flag it.
  const ids = new Set(
    [...packagedRubric.areas, ...packagedRubric.qualities].map(({ id }) => id),
  )
  const kinds = committed.screenshots.flatMap(({ flag, ok }) =>
    [...flag, ...ok].flatMap(({ kinds }) => kinds),
  )
  expect(kinds.filter((kind) => !ids.has(kind))).toEqual([])
})
