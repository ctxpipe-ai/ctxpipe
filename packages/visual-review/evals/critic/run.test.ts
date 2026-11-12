// The dry run of the bake-off: every arm on a small case set, with msw in
// place of OpenRouter and of the Jev Decisions API, and a stand-in package
// for the local judge of BlazeDiff (its models do not run in a test).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
import { sha256Of } from "./images.ts"
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
const pairs = {
  intended: [
    [gray, teal],
    [gray, recolored],
  ],
  regression: [
    [gray, teal],
    [wide, teal],
  ],
  noise: [
    [gray, teal],
    [gray, { ...teal, box: { ...teal.box, x: 41 } }],
  ],
  mixed: [
    [gray, teal],
    [wide, recolored],
  ],
} satisfies Record<string, [Bar[], Bar[]]>
const knownRegion: PixelBox = { x: 38, y: 38, width: 224, height: 34 }

// The images by SHA-256. Each case has its own images: a mark of its own
// color, the same in the before and the after image, so the diff does not
// change.
const stored = new Map<string, Uint8Array>()
let marks = 0
const image = (bars: Bar[], mark: number) => {
  const bytes = screenshot(400, 300, [
    ...bars,
    {
      box: { x: 380, y: 280, width: 10, height: 10 },
      color: [mark * 10, 0, 0],
    },
  ])
  const sha256 = sha256Of(bytes)
  stored.set(sha256, bytes)
  return sha256
}

const sha = (digit: string) => digit.repeat(40)
const common = (id: string, [before, after]: [Bar[], Bar[]]) => {
  const mark = ++marks
  return {
    id,
    storyId: id,
    viewport: { name: "desktop", width: 1440, height: 900 } as const,
    diffPixels: 100,
    images: { before: image(before, mark), after: image(after, mark) },
  }
}
const cases: Case[] = [
  ...[1, 2].map((n): Case => ({
    ...common(`intended-${n}`, pairs.intended),
    kind: "intended",
    label: "intended",
    class: null,
    brief: "Make the status bar blue.",
    commit: { sha: sha("a"), parent: sha("b") },
    region: null,
  })),
  ...[1, 2, 3, 4].map((n): Case => ({
    ...common(`regression-${n}`, pairs.regression),
    kind: "regression",
    label: "regression",
    class: "padding",
    brief: null,
    commit: null,
    region: knownRegion,
  })),
  ...[1, 2].map((n): Case => ({
    ...common(`noise-${n}`, pairs.noise),
    kind: "noise",
    label: "noise",
    class: "subpixel-shift",
    brief: null,
    commit: null,
    region: null,
  })),
  ...[1, 2].map((n): Case => ({
    ...common(`mixed-${n}`, pairs.mixed),
    kind: "mixed",
    label: "regression",
    class: "padding",
    brief: "Make the status bar blue.",
    commit: { sha: sha("a"), parent: sha("b") },
    region: knownRegion,
  })),
]
// A new case has only an after image: two clean renders, and two with a
// synthetic regression (the wide gray bar).
const newCase = (id: string, broken: boolean): Case => ({
  ...common(id, pairs.intended),
  kind: "new",
  label: broken ? "regression" : "intended",
  class: broken ? "padding" : null,
  brief: "Add the status bar.",
  commit: { sha: sha("a"), parent: sha("b") },
  region: broken ? knownRegion : null,
  diffPixels: null,
  images: { after: image(broken ? [wide, teal] : [gray, teal], ++marks) },
})
cases.push(
  newCase("new-clean-1", false),
  newCase("new-clean-2", false),
  newCase("new-broken-1", true),
  newCase("new-broken-2", true),
)
const labelOf = (id: string) => cases.find((entry) => entry.id === id)?.label

const folder = mkdtempSync(join(tmpdir(), "bakeoff-test-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
// The image folder of most tests has all images, so they need no release.
const images = join(folder, "images")
mkdirSync(images)
for (const [sha256, bytes] of stored)
  writeFileSync(join(images, `${sha256}.png`), bytes)
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
      scope: "page",
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
  // A new screenshot: the schema of a judgment on one image.
  if (story?.text?.includes("New screenshots"))
    return HttpResponse.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              observations: [],
              verdict,
              severity: regression ? "major" : "none",
              confidence: 0.9,
              summary: `The new screenshot is ${verdict}.`,
              qualities: [
                {
                  name: "clarity",
                  rating: regression ? "fails" : "meets",
                  confidence: 0.8,
                },
              ],
              findings: regression
                ? [
                    {
                      kind: "spacing",
                      region,
                      evidence: "The gray bar is too wide.",
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
  expect(text).toContain(
    "Cases: 14 (4 in the hold-out set, 4 new screenshots). Runs: 3. Arms: 9.",
  )
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

  // The new screenshots: each arm but the local judge judges them with the
  // judge of a new screenshot. Recall on the broken ones, false alarms on
  // the clean ones, unsure, errors, cost per story, and the verdicts.
  expect(text).toContain("## New screenshots (4 cases)")
  const newRows = rows(text, "## New screenshots")
  const right = ["1.00", "0.00", "0.00", "0"]
  for (const arm of [
    "llm:anthropic/claude-test",
    "llm-one-step:anthropic/claude-test",
    "llm-no-facts:anthropic/claude-test",
    // The cascade sends a new screenshot to the model, as visual:review does.
    "cascade:anthropic/claude-test",
    "cascade:baseten/elephant-1+anthropic/claude-test",
  ])
    expect(newRows.get(arm)).toEqual([...right, "$0.0100", "12"])
  expect(newRows.get("jev")).toEqual([...right, "$0.0010", "12"])
  expect(newRows.get("decision:baseten/elephant-1")).toEqual([
    ...right,
    "$0.0005",
    "12",
  ])
  // The other decision model is never sure.
  expect(newRows.get("decision:typesafe/other-test")).toEqual([
    "0.00",
    "0.00",
    "1.00",
    "0",
    "$0.0020",
    "12",
  ])
  // The local judge needs a before image: not applicable, not an error.
  expect(newRows.get("blazediff-local")).toEqual([
    "not applicable",
    "",
    "",
    "",
    "",
    "",
  ])

  const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"))
  expect(results.results).toHaveLength(9 * 10 * 3 + 8 * 4 * 3)
  expect(results.stopped).toBe(null)
  // Jev places the defect of a broken new screenshot with its box.
  const jevBroken = results.results.find(
    (result: { arm: string; case: string }) =>
      result.arm === "jev" && result.case === "new-broken-1",
  )
  expect(jevBroken.verdict.verdict).toBe("regression")
  const found = jevBroken.verdict.findings[0].region
  for (const side of ["x", "y", "width", "height"] as const)
    expect(found[side]).toBeCloseTo(region[side])

  // The arm without the interpreter facts gets no change type and no
  // confidence; the other arms get both.
  const unlabeled = prompts.filter((text) => text.includes("unlabeled change"))
  expect(unlabeled).toHaveLength(10 * 3)
  expect(unlabeled.filter((text) => text.includes("confidence"))).toEqual([])
  const labeled = prompts.filter(
    (text) =>
      !text.includes("unlabeled change") && !text.includes("New screenshots"),
  )
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
    "0.035",
  ])

  expect(code).toBe(0)
  // A call starts while the spend is below the cap: after $0.00, $0.01,
  // $0.02 and $0.03, not after $0.04.
  expect(calls).toHaveLength(4)
  expect(text).toContain(
    "Spend: $0.04 of the $0.035 cap. The spend cap stopped the run",
  )
  const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"))
  expect(results.stopped).toBe("cost")
  expect(results.results).toHaveLength(4)
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
    "0.1",
  ])

  // The first call has no cost: it counts $0.10, so the spend reaches the
  // cap and no second call starts.
  expect(calls).toHaveLength(1)
  expect(text).toContain(
    "Spend: $0.10 of the $0.1 cap. The spend cap stopped the run",
  )
  expect(text).toContain("1 calls gave no cost")
})

// A fake release: it serves the images by name and counts the downloads.
// `serve` can change the bytes of an image, or give no image.
// The release URL of the runner; msw answers in its place.
const release =
  "https://github.com/ctxpipe-ai/ctxpipe/releases/download/visual-bakeoff-images"
let downloads: string[] = []
const releaseOf = (
  serve: (bytes: Uint8Array, sha256: string) => Uint8Array | null = (bytes) =>
    bytes,
) =>
  http.get(`${release}/:file`, ({ params }) => {
    const name = String(params.file)
    downloads.push(name)
    const sha256 = name.replace(/\.png$/, "")
    const bytes = stored.get(sha256)
    const served = bytes && serve(bytes, sha256)
    return served
      ? // A copy: the body must be only the bytes of the view.
        new HttpResponse(new Uint8Array(served), {
          headers: { "content-type": "image/png" },
        })
      : new HttpResponse(null, { status: 404 })
  })
const fromRelease = async (cache: string, args: string[]) => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", gateway)
  calls = []
  downloads = []
  const out = mkdtempSync(join(folder, "out-"))
  const printed: string[] = []
  const code = await bakeOff(
    [
      "--images",
      cache,
      "--out",
      out,
      "--cases",
      writeManifest(),
      "--runs",
      "1",
      ...args,
    ],
    (text) => printed.push(text),
  )
  return { code, out, text: printed.join("\n") }
}
/** A copy of `bytes` with one changed byte. */
const changedByte = (bytes: Uint8Array) => {
  const changed = new Uint8Array(bytes)
  changed[changed.length - 20] = (changed[changed.length - 20] ?? 0) ^ 1
  return changed
}
const held = () =>
  holdOut(
    caseManifestSchema.parse(JSON.parse(readFileSync(writeManifest(), "utf8"))),
    7,
  )
const files = (entries: readonly Case[]) =>
  [
    ...new Set(
      entries.flatMap(({ images }) =>
        Object.values(images).map((sha256) => `${sha256}.png`),
      ),
    ),
  ].sort()

test("a hold-out-only dry run gets only the images of the hold-out cases from the release, and keeps them", async () => {
  server.use(decisions, releaseOf())
  const cache = join(mkdtempSync(join(folder, "cache-")), "images")
  const heldCases = cases.filter(({ id }) => held().has(id))
  expect(heldCases).toHaveLength(4)

  const first = await fromRelease(cache, ["--arms", "jev", "--hold-out-only"])

  expect(first.code).toBe(0)
  expect(first.text).toContain(
    "Cases: 4 (4 in the hold-out set, 0 new screenshots). Runs: 1. Arms: 1.",
  )
  expect([...downloads].sort()).toEqual(files(heldCases))
  expect(readdirSync(cache).sort()).toEqual(files(heldCases))
  expect(files(cases).length).toBeGreaterThan(files(heldCases).length)

  // A second run takes the images from the folder.
  const second = await fromRelease(cache, ["--arms", "jev", "--hold-out-only"])
  expect(second.code).toBe(0)
  expect(downloads).toEqual([])
})

test("an image with one changed byte fails the hash check before a call", async () => {
  server.use(chat, releaseOf(changedByte))
  const cache = mkdtempSync(join(folder, "cache-"))

  const { code, text } = await fromRelease(cache, [
    "--arms",
    "llm:anthropic/claude-test",
  ])

  expect(code).toBe(2)
  expect(text).toMatch(
    /Case \S+ has no usable image: The image \w+\.png from https:\/\/github\.com\/ctxpipe-ai\/ctxpipe\/releases\/download\/visual-bakeoff-images\/\w+\.png does not have the SHA-256 of the manifest\./,
  )
  expect(calls).toEqual([])
  expect(readdirSync(cache)).toEqual([])
})

test("a changed image in the image folder fails the hash check too", async () => {
  server.use(chat, releaseOf())
  const cache = mkdtempSync(join(folder, "cache-"))
  const [name] = files(cases.filter(({ id }) => held().has(id)))
  writeFileSync(
    join(cache, name ?? ""),
    changedByte(readFileSync(join(images, name ?? ""))),
  )

  const { code, text } = await fromRelease(cache, [
    "--arms",
    "llm:anthropic/claude-test",
  ])

  expect(code).toBe(2)
  expect(text).toContain(`The image ${name} from ${cache}`)
})

test("an image that the release does not have stops the run after the hold-out cases, with their report", async () => {
  const heldFiles = new Set(files(cases.filter(({ id }) => held().has(id))))
  server.use(
    decisions,
    releaseOf((bytes, sha256) =>
      heldFiles.has(`${sha256}.png`) ? bytes : null,
    ),
  )
  const cache = mkdtempSync(join(folder, "cache-"))

  const { code, out, text } = await fromRelease(cache, ["--arms", "jev"])

  expect(code).toBe(2)
  expect(text).toMatch(/Case \S+ has no usable image: .* gave 404\./)
  expect(text).toContain(
    "The check of the case images stopped the run: the tables count only the cases and runs that every arm judged.",
  )
  expect(text).toContain("## Hold-out set (4 cases)")
  expect(text).toContain("## Other cases (0 cases)")
  expect(readFileSync(join(out, "report.md"), "utf8")).toBe(
    `${text.slice(text.indexOf("# Visual critic bake-off"))}\n`,
  )
})

test("a run that the spend cap stops before its first call gets no image", async () => {
  server.use(chat, releaseOf())
  const cache = mkdtempSync(join(folder, "cache-"))

  const { code, text } = await fromRelease(cache, [
    "--arms",
    "llm:anthropic/claude-test",
    "--max-cost",
    "0",
  ])

  expect(code).toBe(0)
  expect(text).toContain("The spend cap stopped the run")
  expect(downloads).toEqual([])
  expect(calls).toEqual([])
})

test("a capped run with workers at the same time lets the calls in flight finish, and starts no call above the cap", async () => {
  // Each call waits until all four workers made their call. Thus the four
  // calls are in flight together, and no worker sees the cost of another
  // call first. The result does not depend on the timing of the workers.
  let arrive = () => {}
  const allInFlight = new Promise<void>((done) => {
    let arrived = 0
    arrive = () => {
      if (++arrived === 4) done()
    }
  })
  const together = http.post(`${gateway}/chat/completions`, async () => {
    arrive()
    await allInFlight
    // No response: msw gives the request to the next handler (`chat`).
  })
  server.use(chat, releaseOf())
  server.use(together)
  const cache = mkdtempSync(join(folder, "cache-"))

  // Four workers start at $0.00 and their four calls finish. The spend of
  // $0.04 is then above the cap of $0.03, so no other call starts and no
  // other case gets its images.
  const { code, text } = await fromRelease(cache, [
    "--arms",
    "llm:anthropic/claude-test",
    "--concurrency",
    "4",
    "--max-cost",
    "0.03",
  ])

  expect(code).toBe(0)
  expect(text).toContain("The spend cap stopped the run")
  expect(calls).toHaveLength(4)
  const called = calls.map((call) => call.split(" ")[1])
  expect([...downloads].sort()).toEqual(
    files(cases.filter(({ id }) => called.includes(id))),
  )
})

test("an arm that judges no new screenshot gets no image of a new case", async () => {
  server.use(releaseOf())
  const cache = mkdtempSync(join(folder, "cache-"))

  const { code } = await fromRelease(cache, [
    "--arms",
    "blazediff-local",
    "--blazediff-agent",
    agent,
  ])

  expect(code).toBe(0)
  expect([...downloads].sort()).toEqual(
    files(cases.filter(({ kind }) => kind !== "new")),
  )
})

test("a real change that the owner labeled unsure does not run", async () => {
  server.use(decisions)
  const { code, text } = await run([
    "--cases",
    writeManifest({
      cases: cases.map((entry) =>
        entry.id === "intended-1" ? { ...entry, label: "unsure" } : entry,
      ),
    }),
    "--arms",
    "jev",
    "--runs",
    "1",
  ])

  expect(code).toBe(0)
  expect(text).toContain("Cases: 13")
  expect(calls.some((call) => call.endsWith(" intended-1"))).toBe(false)
  expect(calls.some((call) => call.endsWith(" intended-2"))).toBe(true)
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

test("the report marks an arm whose model is on the judge panel", async () => {
  server.use(chat, decisions)
  const manifest = writeManifest({
    panelModels: ["anthropic/claude-test", "vendor-b/judge", "vendor-c/judge"],
  })
  const { text } = await run([
    "--cases",
    manifest,
    "--arms",
    "jev,llm:anthropic/claude-test,cascade:anthropic/claude-test,llm-no-facts:openrouter/anthropic/claude-test",
    "--runs",
    "1",
  ])

  expect(text).toContain(
    "The labels of the real changes come from the judge panel (anthropic/claude-test, vendor-b/judge, vendor-c/judge).",
  )
  const arms = [...rows(text, "## Hold-out set").keys()]
  expect(arms).toEqual([
    "jev",
    "llm:anthropic/claude-test (panel)",
    "cascade:anthropic/claude-test (panel)",
    // The same model, as the adapter sends it.
    "llm-no-facts:openrouter/anthropic/claude-test (panel)",
  ])
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
    intended: 11,
    regression: 24,
    noise: 6,
    mixed: 6,
  })
  expect([...holdOut(manifest, manifest.seed)]).toEqual([...held])
  expect(holdOut(manifest, manifest.seed + 1)).not.toEqual(held)
})
