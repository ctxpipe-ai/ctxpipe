// The dry run of the bake-off: every arm on a small case set, with msw in
// place of OpenRouter and of the Jev Decisions API, and a stand-in package
// for the local judge of BlazeDiff (its models do not run in a test).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"

import type { PixelBox } from "../../src/compare/diff.ts"
import { screenshot } from "../../src/compare/fixtures.ts"
import { caseManifestSchema, type Case } from "./cases.ts"
import { bakeOff, holdOut } from "./run.ts"

const gateway = "https://gateway.test/api/v1"
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  priced = true
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

// The cases: a gray bar and a teal bar on a white 400 × 300 page.
type Bar = { box: PixelBox; color: readonly [number, number, number] }
const gray: Bar = {
  box: { x: 40, y: 40, width: 120, height: 30 },
  color: [120, 120, 120],
}
const teal: Bar = {
  box: { x: 40, y: 100, width: 200, height: 20 },
  color: [20, 150, 140],
}
const recolored: Bar = { ...teal, color: [30, 90, 200] }
const wide: Bar = { ...gray, box: { ...gray.box, width: 220 } }
const page = (...bars: Bar[]) => screenshot(400, 300, bars)
const pairs = {
  intended: [page(gray, teal), page(gray, recolored)],
  regression: [page(gray, teal), page(wide, teal)],
  noise: [
    page(gray, teal),
    page(gray, { ...teal, box: { ...teal.box, x: 41 } }),
  ],
  mixed: [page(gray, teal), page(wide, recolored)],
} as const
const knownRegion: PixelBox = { x: 38, y: 38, width: 224, height: 34 }

const sha = (digit: string) => digit.repeat(40)
const common = (id: string) => ({
  id,
  storyId: id,
  viewport: { name: "desktop", width: 1440, height: 900 } as const,
  diffPixels: 100,
  images: { before: `cases/${id}/before.png`, after: `cases/${id}/after.png` },
})
const cases: Case[] = [
  ...[1, 2].map((n): Case => ({
    ...common(`intended-${n}`),
    kind: "intended",
    label: "intended",
    class: null,
    brief: "Make the status bar blue.",
    commit: { sha: sha("a"), parent: sha("b") },
    region: null,
  })),
  ...[1, 2, 3, 4].map((n): Case => ({
    ...common(`regression-${n}`),
    kind: "regression",
    label: "regression",
    class: "padding",
    brief: null,
    commit: null,
    region: knownRegion,
  })),
  ...[1, 2].map((n): Case => ({
    ...common(`noise-${n}`),
    kind: "noise",
    label: "noise",
    class: "subpixel-shift",
    brief: null,
    commit: null,
    region: null,
  })),
  ...[1, 2].map((n): Case => ({
    ...common(`mixed-${n}`),
    kind: "mixed",
    label: "regression",
    class: "padding",
    brief: "Make the status bar blue.",
    commit: { sha: sha("a"), parent: sha("b") },
    region: knownRegion,
  })),
]
const labelOf = (id: string) => cases.find((entry) => entry.id === id)?.label

const folder = mkdtempSync(join(tmpdir(), "bakeoff-test-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
const images = join(folder, "images")
for (const entry of cases) {
  const [before, after] = pairs[entry.kind]
  mkdirSync(join(images, "cases", entry.id), { recursive: true })
  writeFileSync(join(images, entry.images.before), before)
  writeFileSync(join(images, entry.images.after), after)
}
const writeManifest = (extra: object = {}) => {
  const path = join(mkdtempSync(join(folder, "manifest-")), "cases.json")
  writeFileSync(
    path,
    JSON.stringify({
      $schema: "./cases.schema.json",
      version: 1,
      seed: 7,
      until: sha("c"),
      container: "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:0",
      cases,
      ...extra,
    }),
  )
  return path
}

// A stand-in for @blazediff/agent: the local judge labels a case by its id,
// and calls each mixed case intended.
const agent = join(folder, "agent")
mkdirSync(join(agent, "node_modules/@blazediff/agent/dist"), {
  recursive: true,
})
writeFileSync(
  join(agent, "node_modules/@blazediff/agent/dist/index.mjs"),
  `export const resolveJudge = () => ({
  async judge({ entry }) {
    const label = entry.id.startsWith("regression") ? "regression-likely"
      : entry.id.startsWith("noise") ? "noise-likely" : "intentional-likely"
    return { kind: "judged", verdict: { label, headline: label, rationale: [], action: "investigate" } }
  },
})\n`,
)

const region = {
  x: knownRegion.x / 400,
  y: knownRegion.y / 300,
  width: knownRegion.width / 400,
  height: knownRegion.height / 300,
}
const storyOf = (text: string) => /Story: (\S+)/.exec(text)?.[1] ?? ""

let calls: string[] = []
let prompts: string[] = []
// When false, no call gives its cost.
let priced = true
// The LLM is right with the critic prompt, and calls each case a regression
// with the one-step prompt. Each call costs $0.01.
const chat = http.post(`${gateway}/chat/completions`, async ({ request }) => {
  const body = (await request.json()) as {
    model: string
    messages: { content: { type: string; text?: string }[] }[]
  }
  const [prefix, story] = body.messages[0]?.content ?? []
  const id = storyOf(story?.text ?? "")
  calls.push(`${body.model} ${id}`)
  prompts.push(story?.text ?? "")
  const verdict = prefix?.text?.includes("in one step")
    ? "regression"
    : labelOf(id)
  const regression = verdict === "regression"
  return HttpResponse.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            observations: [],
            verdict,
            severity: regression ? "major" : "none",
            confidence: 0.9,
            summary: `The case is ${verdict}.`,
            qualities: [
              {
                name: "clarity",
                delta: regression ? "worse" : "same",
                confidence: 0.8,
              },
            ],
            findings: regression
              ? [
                  {
                    kind: "spacing",
                    region,
                    evidence: "The gray bar is wider.",
                    rubricRef: "apps/ui/DESIGN.md › Space",
                    explainedByBrief: false,
                    suggestion: null,
                  },
                ]
              : [],
          }),
        },
      },
    ],
    usage: priced ? { cost: 0.01 } : {},
  })
})
// Jev finds each regression and its box ($0.001 a call). Elephant finds each
// regression, and answers 400 to a box question, as the API does ($0.0005 a
// call). The other decision model is never sure ($0.002 a call).
const decisions = http.post(
  "https://gateway.test/api/alpha/decisions",
  async ({ request }) => {
    const body = (await request.json()) as {
      model: string
      state: unknown[]
      questions: Record<string, { type: string }>
    }
    const id = storyOf(
      body.state.filter((part) => typeof part === "string").join("\n"),
    )
    calls.push(`${body.model} ${id}`)
    const jev = body.model === "typesafe/jev-1.14"
    const elephant = body.model === "baseten/elephant-1"
    if (
      !jev &&
      Object.values(body.questions).some(({ type }) => type === "box")
    )
      return HttpResponse.json(
        { error: { message: "Only Jev 1.14 takes a box question." } },
        { status: 400 },
      )
    const finds = jev || elephant
    const regression = finds && labelOf(id) === "regression"
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([name, { type }]) => [
        name,
        type === "noul"
          ? { type, noul: finds ? (regression ? 0.9 : 0.05) : 0.3 }
          : type === "box"
            ? {
                type,
                box: {
                  left: region.x,
                  top: region.y,
                  right: region.x + region.width,
                  bottom: region.y + region.height,
                },
              }
            : {
                type,
                probabilities:
                  regression && name === "area.spacing"
                    ? { better: 0.05, same: 0.05, worse: 0.9 }
                    : { better: 0.02, same: 0.96, worse: 0.02 },
              },
      ]),
    )
    return HttpResponse.json({
      model: body.model,
      answers,
      usage: { cost: jev ? 0.001 : elephant ? 0.0005 : 0.002 },
    })
  },
)

const run = async (args: string[]) => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", gateway)
  calls = []
  prompts = []
  const out = mkdtempSync(join(folder, "out-"))
  const printed: string[] = []
  const code = await bakeOff(
    ["--images", images, "--out", out, "--concurrency", "2", ...args],
    (text) => printed.push(text),
  )
  return { code, out, text: printed.join("\n") }
}

/** The cells of the rows of the first table after `heading`, by arm. */
const rows = (text: string, heading: string) => {
  const section = text.slice(text.indexOf(heading))
  const table = section.slice(section.indexOf("| Arm"))
  const lines = table.slice(0, table.indexOf("\n\n")).split("\n").slice(2)
  return new Map(
    lines.map((line) => {
      const [arm = "", ...cells] = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
      return [arm.replaceAll("`", ""), cells]
    }),
  )
}

test("a dry run judges every case with every arm and selects the cheapest arm that finds the regressions", async () => {
  server.use(chat, decisions)
  const { code, out, text } = await run([
    "--cases",
    writeManifest(),
    "--arms",
    [
      "llm:anthropic/claude-test",
      "llm-one-step:anthropic/claude-test",
      "llm-no-facts:anthropic/claude-test",
      "jev",
      "decision:typesafe/other-test",
      "decision:baseten/elephant-1",
      "cascade:anthropic/claude-test",
      "cascade:baseten/elephant-1+anthropic/claude-test",
      "blazediff-local",
    ].join(","),
    "--blazediff-agent",
    agent,
  ])

  expect(code).toBe(0)
  expect(readFileSync(join(out, "report.md"), "utf8")).toBe(`${text}\n`)
  expect(text).toContain("Cases: 10 (4 in the hold-out set). Runs: 3. Arms: 9.")
  expect(text).toContain("## Hold-out set (4 cases)")
  expect(text).toContain("## Other cases (6 cases)")
  // Recall, precision, unsure, errors, then (after the agreement columns)
  // consistency, cost per story, and at the end taste and the verdicts.
  const held = rows(text, "## Hold-out set")
  const pick = (arm: string) => {
    const cells = held.get(arm) ?? []
    return [
      cells[0],
      cells[1],
      cells[2],
      cells[3],
      cells[7],
      cells[8],
      cells[11],
      cells[12],
    ]
  }
  expect(pick("llm:anthropic/claude-test")).toEqual([
    "1.00",
    "1.00",
    "0.00",
    "0",
    "1.00",
    "$0.0100",
    "no labels yet",
    "12",
  ])
  expect(pick("llm-one-step:anthropic/claude-test")).toEqual([
    "1.00",
    "0.50",
    "0.00",
    "0",
    "1.00",
    "$0.0100",
    "no labels yet",
    "12",
  ])
  expect(pick("llm-no-facts:anthropic/claude-test")).toEqual([
    "1.00",
    "1.00",
    "0.00",
    "0",
    "1.00",
    "$0.0100",
    "no labels yet",
    "12",
  ])
  // Jev cannot call the noise case intended without a brief: unsure.
  expect(pick("jev")).toEqual([
    "1.00",
    "1.00",
    "0.25",
    "0",
    "1.00",
    "$0.0010",
    "no labels yet",
    "12",
  ])
  expect(pick("decision:typesafe/other-test")).toEqual([
    "0.00",
    "–",
    "1.00",
    "0",
    "1.00",
    "$0.0020",
    "no labels yet",
    "12",
  ])
  // Elephant gets no box question; a worse area takes the largest measured
  // region. Like Jev, it cannot call the noise case intended.
  expect(pick("decision:baseten/elephant-1")).toEqual([
    "1.00",
    "1.00",
    "0.25",
    "0",
    "1.00",
    "$0.0005",
    "no labels yet",
    "12",
  ])
  // Jev accepts the intended case; the LLM judges the other three.
  expect(pick("cascade:anthropic/claude-test")).toEqual([
    "1.00",
    "1.00",
    "0.00",
    "0",
    "1.00",
    "$0.0085",
    "no labels yet",
    "12",
  ])
  // The same cascade with Elephant as the filter.
  expect(pick("cascade:baseten/elephant-1+anthropic/claude-test")).toEqual([
    "1.00",
    "1.00",
    "0.00",
    "0",
    "1.00",
    "$0.0080",
    "no labels yet",
    "12",
  ])
  // The local judge calls the mixed case intended, and costs nothing.
  expect(pick("blazediff-local")).toEqual([
    "0.50",
    "1.00",
    "0.00",
    "0",
    "1.00",
    "$0.0000",
    "no labels yet",
    "12",
  ])
  expect(text).toContain(
    "Selected: `decision:baseten/elephant-1`, the cheapest of the arms with recall ≥ 0.9 and precision ≥ 0.7 on the hold-out set (`decision:baseten/elephant-1`, `jev`, `cascade:baseten/elephant-1+anthropic/claude-test`, `cascade:anthropic/claude-test`, `llm:anthropic/claude-test`, `llm-no-facts:anthropic/claude-test`).",
  )
  // The LLM finds the known region exactly. It rates only clarity, as most
  // arms do; the local judge rates no quality.
  expect(held.get("llm:anthropic/claude-test")?.slice(4, 7)).toEqual([
    "1.00",
    "1.00",
    "1.00",
  ])
  expect(held.get("blazediff-local")?.slice(4, 7)).toEqual([
    "0.50",
    "–",
    "0.00",
  ])

  const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"))
  expect(results.results).toHaveLength(9 * 10 * 3)
  expect(results.stopped).toBe(null)

  // The arm without the interpreter facts gets no change type and no
  // confidence; the other arms get both.
  const unlabeled = prompts.filter((text) => text.includes("unlabeled change"))
  expect(unlabeled).toHaveLength(10 * 3)
  expect(unlabeled.filter((text) => text.includes("confidence"))).toEqual([])
  const labeled = prompts.filter((text) => !text.includes("unlabeled change"))
  expect(labeled.length).toBeGreaterThan(0)
  expect(labeled.every((text) => text.includes("; confidence "))).toBe(true)
})

test("the spend cap stops the paid calls, and the report says so", async () => {
  server.use(chat)
  const { code, out, text } = await run([
    "--cases",
    writeManifest(),
    "--arms",
    "llm:anthropic/claude-test",
    "--runs",
    "1",
    "--concurrency",
    "1",
    "--max-cost",
    "0.135",
  ])

  expect(code).toBe(0)
  // A call starts when its estimate of $0.10 fits under the cap: after
  // $0.00, $0.01, $0.02 and $0.03, not after $0.04.
  expect(calls).toHaveLength(4)
  expect(text).toContain(
    "Spend: $0.04 of the $0.135 cap. The spend cap stopped the run",
  )
  const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"))
  expect(results.stopped).toBe("cost")
  expect(results.results).toHaveLength(4)
})

test("calls at the same time cannot pass the spend cap together", async () => {
  server.use(chat)
  const { text } = await run([
    "--cases",
    writeManifest(),
    "--arms",
    "llm:anthropic/claude-test",
    "--runs",
    "1",
    "--concurrency",
    "4",
    "--max-cost",
    "0.115",
  ])

  // The first call holds $0.10 while it runs, so the estimate of a second
  // call does not fit, and the other three workers start no call. The first
  // worker then does the same calls as one worker alone: after $0.00 and
  // $0.01, not after $0.02. Without the hold, four calls start at $0.00.
  expect(calls).toHaveLength(2)
  expect(text).toContain(
    "Spend: $0.02 of the $0.115 cap. The spend cap stopped the run",
  )
})

test("a call without a cost counts as at least $0.10, also before any priced call", async () => {
  server.use(chat)
  priced = false
  const { text } = await run([
    "--cases",
    writeManifest(),
    "--arms",
    "llm:anthropic/claude-test",
    "--runs",
    "1",
    "--concurrency",
    "1",
    "--max-cost",
    "0.135",
  ])

  // The first call has no cost: it counts $0.10, so a second estimate of
  // $0.10 does not fit under the cap.
  expect(calls).toHaveLength(1)
  expect(text).toContain(
    "Spend: $0.10 of the $0.135 cap. The spend cap stopped the run",
  )
  expect(text).toContain("1 calls gave no cost")
})

test("an image that links outside the image folder stops the run before a call", async () => {
  server.use(chat)
  const linked = mkdtempSync(join(folder, "linked-"))
  const outside = join(folder, "private.png")
  writeFileSync(outside, pairs.intended[0])
  for (const entry of cases) {
    mkdirSync(join(linked, "cases", entry.id), { recursive: true })
    writeFileSync(join(linked, entry.images.before), pairs[entry.kind][0])
    writeFileSync(join(linked, entry.images.after), pairs[entry.kind][1])
  }
  const target = join(linked, "cases", "regression-1", "after.png")
  rmSync(target)
  symlinkSync(outside, target)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", gateway)
  calls = []
  const printed: string[] = []

  const code = await bakeOff(
    [
      "--images",
      linked,
      "--out",
      mkdtempSync(join(folder, "out-")),
      "--cases",
      writeManifest(),
      "--arms",
      "llm:anthropic/claude-test",
    ],
    (text) => printed.push(text),
  )

  expect(code).toBe(2)
  expect(printed.join("\n")).toContain("Case regression-1 has no usable image")
  expect(calls).toEqual([])
})

test("the taste win rate comes from the owner picks in the manifest", async () => {
  server.use(chat, decisions)
  const manifest = writeManifest({
    taste: [
      {
        case: "regression-1",
        arms: ["jev", "llm:anthropic/claude-test"],
        winner: "llm:anthropic/claude-test",
      },
      {
        case: "regression-2",
        arms: ["jev", "llm:anthropic/claude-test"],
        winner: "tie",
      },
      {
        case: "regression-3",
        arms: ["jev", "llm:anthropic/claude-test"],
        winner: "llm:anthropic/claude-test",
      },
      {
        case: "regression-4",
        arms: ["jev", "llm:anthropic/claude-test"],
        winner: "jev",
      },
    ],
  })
  const { text } = await run([
    "--cases",
    manifest,
    "--arms",
    "jev,llm:anthropic/claude-test",
    "--runs",
    "1",
  ])

  expect(text).not.toContain("no labels yet")
  // Taste is the second last cell. One regression case is in the hold-out
  // set, three are in the other cases.
  const taste = (heading: string, arm: string) =>
    rows(text, heading).get(arm)?.at(-2)
  const all = ["## Hold-out set", "## Other cases"]
  const llm = all.map((heading) => taste(heading, "llm:anthropic/claude-test"))
  const jev = all.map((heading) => taste(heading, "jev"))
  // Over the four picks: the LLM wins 2, ties 1, loses 1.
  const score = (cell: string | undefined, picks: number) =>
    Number(cell) * picks
  expect(score(llm[0], 1) + score(llm[1], 3)).toBeCloseTo(2.5)
  expect(score(jev[0], 1) + score(jev[1], 3)).toBeCloseTo(1.5)
})

test("the hold-out set is 30% of each kind of the committed cases, the same for the same seed", () => {
  const manifest = caseManifestSchema.parse(
    JSON.parse(readFileSync(join(import.meta.dirname, "cases.json"), "utf8")),
  )
  const held = holdOut(manifest, manifest.seed)
  const kinds = (set: Set<string>) =>
    Object.fromEntries(
      ["intended", "regression", "noise", "mixed"].map((kind) => [
        kind,
        manifest.cases.filter(({ id, kind: k }) => k === kind && set.has(id))
          .length,
      ]),
    )

  expect(kinds(held)).toEqual({
    intended: 18,
    regression: 24,
    noise: 6,
    mixed: 6,
  })
  expect([...holdOut(manifest, manifest.seed)]).toEqual([...held])
  expect(holdOut(manifest, manifest.seed + 1)).not.toEqual(held)
})
