// The dry run of the judge panel: three members on a small case set, with
// msw in place of OpenRouter. No paid model is called.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"

import { screenshot } from "../../src/compare/fixtures.ts"
import { caseManifestSchema, type Case, type PanelLabel } from "./cases.ts"
import { sha256Of } from "./images.ts"
import { agreement, judgePanel } from "./panel.ts"

const gateway = "https://gateway.test/api/v1"
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

const members = ["vendor-a/judge", "vendor-b/judge", "vendor-c/judge"]

// The images: a gray bar that gets wider in the after image, on a white
// 400 × 300 page, with a mark of its own color for each case.
const folder = mkdtempSync(join(tmpdir(), "bakeoff-panel-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
const images = join(folder, "images")
mkdirSync(images)
let marks = 0
const image = (width: number, mark: number) => {
  const bytes = screenshot(400, 300, [
    { box: { x: 40, y: 40, width, height: 30 }, color: [120, 120, 120] },
    { box: { x: 380, y: 280, width: 10, height: 10 }, color: [mark, 0, 0] },
  ])
  const sha256 = sha256Of(bytes)
  writeFileSync(join(images, `${sha256}.png`), bytes)
  return sha256
}
const sha = (digit: string) => digit.repeat(40)
const common = (id: string) => {
  const mark = (marks += 10)
  return {
    id,
    storyId: `pages-home--${id}`,
    viewport: { name: "desktop", width: 1440, height: 900 } as const,
    diffPixels: 3000,
    images: { before: image(120, mark), after: image(220, mark) },
  }
}
const real = (id: string): Case => ({
  ...common(id),
  kind: "intended",
  label: "unsure",
  class: null,
  brief: "Make the gray bar wider.",
  commit: { sha: sha("a"), parent: sha("b") },
  region: null,
})
const region = { x: 38, y: 38, width: 224, height: 34 }
const cases: Case[] = [
  real("intended-agree"),
  real("intended-split"),
  real("intended-majority"),
  {
    ...common("regression-1"),
    kind: "regression",
    label: "regression",
    class: "padding",
    brief: null,
    commit: null,
    region,
  },
  {
    ...common("noise-1"),
    kind: "noise",
    label: "noise",
    class: "subpixel-shift",
    brief: null,
    commit: null,
    region: null,
  },
  {
    ...common("mixed-1"),
    kind: "mixed",
    label: "regression",
    class: "padding",
    brief: "Make the gray bar wider.",
    commit: { sha: sha("a"), parent: sha("b") },
    region,
  },
  {
    ...common("new-1"),
    kind: "new",
    label: "intended",
    class: null,
    brief: "Add the gray bar.",
    commit: { sha: sha("a"), parent: sha("b") },
    region: null,
    diffPixels: null,
    images: { after: image(120, ++marks) },
  },
]
const writeManifest = () => {
  const path = join(mkdtempSync(join(folder, "manifest-")), "cases.json")
  writeFileSync(
    path,
    JSON.stringify({
      $schema: "./cases.schema.json",
      version: 1,
      seed: 1,
      until: sha("c"),
      container: "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:0",
      scope: "page",
      cases,
    }),
  )
  return path
}

// The vote of each member on each case, in the order of `members`. A null
// vote is a reply that is not JSON.
const script: Record<string, (PanelLabel | null)[]> = {
  "intended-agree": ["improvement", "improvement", "improvement"],
  "intended-split": ["improvement", "regression", "no-change"],
  "intended-majority": ["improvement", "no-change", "no-change"],
  "regression-1": ["regression", "regression", "regression"],
  "noise-1": ["no-change", "no-change", "improvement"],
  "mixed-1": ["regression", "regression", null],
}
type Call = { model: string; prefix: string; story: string; images: number }
let calls: Call[] = []
const chat = http.post(`${gateway}/chat/completions`, async ({ request }) => {
  expect(request.headers.get("authorization")).toBe("Bearer test-key")
  const body = (await request.json()) as {
    model: string
    messages: { content: { type: string; text?: string }[] }[]
  }
  const [prefix, story, ...attached] = body.messages[0]?.content ?? []
  calls.push({
    model: body.model,
    prefix: prefix?.text ?? "",
    story: story?.text ?? "",
    images: attached.length,
  })
  const id = /Story: pages-home--(\S+)/.exec(story?.text ?? "")?.[1] ?? ""
  const label = script[id]?.[members.indexOf(body.model)]
  return HttpResponse.json({
    choices: [
      {
        message: {
          content:
            label === undefined || label === null
              ? "I cannot tell."
              : JSON.stringify({
                  reason: `${body.model} sees: the gray bar is wider.`,
                  label,
                }),
        },
      },
    ],
    usage: { cost: 0.02 },
  })
})

const run = async (extra: string[] = [], path = writeManifest()) => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", gateway)
  const printed: string[] = []
  const code = await judgePanel(
    [
      "--models",
      members.join(","),
      "--images",
      images,
      "--cases",
      path,
      ...extra,
    ],
    (text) => printed.push(text),
  )
  const manifest = caseManifestSchema.parse(
    JSON.parse(readFileSync(path, "utf8")),
  )
  return { code, manifest, path, text: printed.join("\n") }
}

test("the agreement rule: a plain majority of the members", () => {
  const votes = (...labels: (PanelLabel | null)[]) =>
    labels.map((label) => ({ label }))
  expect(agreement(votes("improvement", "improvement", "no-change"))).toBe(
    "improvement",
  )
  expect(agreement(votes("no-change", "no-change", "improvement"))).toBe(
    "no-change",
  )
  expect(agreement(votes("regression", "regression", "regression"))).toBe(
    "regression",
  )
  // A failed vote stays in the count of the members.
  expect(agreement(votes("regression", "regression", null))).toBe("regression")
  expect(agreement(votes("improvement", null, null))).toBeNull()
  // Two against one: the majority label counts, also for regression.
  expect(agreement(votes("regression", "regression", "no-change"))).toBe(
    "regression",
  )
  expect(agreement(votes("improvement", "improvement", "regression"))).toBe(
    "improvement",
  )
  // No majority.
  expect(agreement(votes("improvement", "no-change", null))).toBeNull()
  expect(agreement(votes("improvement", "regression", "no-change"))).toBeNull()
})

test("a dry run labels each change case with the panel, and leaves the disagreements to the owner", async () => {
  calls = []
  server.use(chat)

  const { code, manifest, text } = await run()

  expect(code).toBe(0)
  // Each member judges each change case once. A new case has no before
  // image, so the panel does not judge it.
  expect(calls).toHaveLength(3 * 6)
  expect(calls.some(({ story }) => story.includes("new-1"))).toBe(false)
  // The same prompt for each member, with the scope, the brief and the
  // rubric, and the images of the compare engine. No member sees a vote.
  for (const id of Object.keys(script)) {
    const ofCase = calls.filter(({ story }) => story.includes(`--${id}\n`))
    expect(new Set(ofCase.map(({ model }) => model))).toEqual(new Set(members))
    expect(
      new Set(ofCase.map(({ prefix, story }) => prefix + story)).size,
    ).toBe(1)
  }
  const [first] = calls
  expect(first?.story).toContain("Scope: page.")
  expect(first?.prefix).toContain("Rubric, layer 2, the design qualities")
  expect(first?.prefix).toContain("`no-change`")
  expect(first?.images).toBeGreaterThan(1)
  expect(
    calls.some(({ story }) => story.includes("Make the gray bar wider.")),
  ).toBe(true)
  for (const { prefix, story } of calls)
    expect(prefix + story).not.toContain("sees: the gray bar")

  const byId = new Map(manifest.cases.map((entry) => [entry.id, entry]))
  expect(manifest.panelModels).toEqual(members)
  // The labels and the reasons go into the manifest.
  expect(byId.get("intended-agree")?.panel?.votes[0]).toEqual({
    model: "vendor-a/judge",
    label: "improvement",
    reason: "vendor-a/judge sees: the gray bar is wider.",
  })
  expect(byId.get("intended-agree")?.label).toBe("intended")
  expect(byId.get("intended-majority")?.label).toBe("noise")
  // No agreement: the case leaves the scored set, for the owner queue.
  expect(byId.get("intended-split")?.panel?.label).toBeNull()
  expect(byId.get("intended-split")?.label).toBe("unsure")
  // A synthetic case keeps its known label; the panel result measures the
  // panel.
  expect(byId.get("mixed-1")?.panel?.label).toBe("regression")
  expect(byId.get("mixed-1")?.panel?.votes[2]?.error).toContain("not JSON")
  expect(byId.get("noise-1")?.label).toBe("noise")
  expect(byId.get("new-1")?.panel).toBeUndefined()

  expect(text).toContain(
    "Real changes: 2 labeled (1 improvement, 0 regression, 1 no-change), 1 without agreement, for the owner queue: intended-split.",
  )
  expect(text).toContain(
    "Known labels: the panel label is right on 3 of 3 synthetic cases.",
  )
  expect(text).toContain("- vendor-c/judge: 1 of 3 votes right; 1 errors.")
  expect(text).toContain("6 cases judged, $0.36 of the $40 cap.")
})

test("a second run judges again only the cases with a failed vote, and keeps a label of the owner", async () => {
  calls = []
  server.use(chat)
  const { path } = await run()
  // The owner labeled the real change without agreement. It also has a
  // failed vote now.
  const written = JSON.parse(readFileSync(path, "utf8")) as {
    cases: { id: string; label: string; panel: { votes: object[] } }[]
  }
  const split = written.cases.find(({ id }) => id === "intended-split")
  if (!split) throw new Error("No case.")
  split.label = "regression"
  split.panel.votes[2] = { ...split.panel.votes[2], label: null, error: "500" }
  writeFileSync(path, JSON.stringify(written))
  calls = []

  const { code, manifest } = await run([], path)

  expect(code).toBe(0)
  // Only mixed-1 has a failed vote: its three members judge it again.
  expect(calls).toHaveLength(3)
  expect(calls.every(({ story }) => story.includes("--mixed-1\n"))).toBe(true)
  expect(
    manifest.cases.find(({ id }) => id === "intended-agree")?.panel?.label,
  ).toBe("improvement")
  expect(manifest.cases.find(({ id }) => id === "intended-split")?.label).toBe(
    "regression",
  )
})

test("the spend cap stops the panel before a call, and a case without all votes gets no panel", async () => {
  calls = []
  server.use(chat)

  const { code, manifest, text } = await run(["--max-cost", "0"])

  expect(code).toBe(0)
  expect(calls).toHaveLength(0)
  expect(manifest.cases.every(({ panel }) => panel === undefined)).toBe(true)
  expect(text).toContain("The spend cap stopped the panel")
})

test("the panel needs three different models and the key", async () => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  const printed: string[] = []
  expect(
    await judgePanel(["--models", "a/one,b/two"], (text) => printed.push(text)),
  ).toBe(2)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "")
  expect(await judgePanel([], (text) => printed.push(text))).toBe(2)
  expect(printed.join("\n")).toContain("Set MODEL_PROVIDER_API_KEY")
})
