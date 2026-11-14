// The dry run of the judge panel of the unseen calibration set: three
// members on four screenshots, with msw in place of OpenRouter. No paid
// model is called.
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
import { unseenSchema, type Unseen } from "./calibration.ts"
import { sha256Of } from "./images.ts"
import { labelUnseen, unanimous } from "./label-unseen.ts"

const gateway = "https://gateway.test/api/v1"
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

const members = ["vendor-a/judge", "vendor-b/judge", "vendor-c/judge"]

const folder = mkdtempSync(join(tmpdir(), "bakeoff-unseen-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
const images = join(folder, "images")
mkdirSync(images)
let marks = 0
// A gray bar of `width` on a white page, with a mark of its own color.
const image = (width: number) => {
  const bytes = screenshot(400, 300, [
    { box: { x: 40, y: 40, width, height: 30 }, color: [120, 120, 120] },
    {
      box: { x: 380, y: 280, width: 10, height: 10 },
      color: [(marks += 10), 0, 0],
    },
  ])
  const sha256 = sha256Of(bytes)
  writeFileSync(join(images, `${sha256}.png`), bytes)
  return sha256
}
const shot = (id: string, source: string) => ({
  id,
  source,
  path: `apps/ui/src/screenshots/${id}.desktop.screenshot.png`,
  commit: "a".repeat(40),
  image: image(220),
  scope: "page" as const,
  viewport: "desktop" as const,
})
const unseen: Unseen = {
  selected: "2026-11-15",
  screenshots: [
    shot("new-agree", "main"),
    shot("new-split", "main"),
    shot("new-error", "main"),
    {
      ...shot("change-agree", "pr-722-round-3"),
      before: { image: image(120), brief: "Make the gray bar wider." },
    },
  ],
}
const writeSet = () => {
  const path = join(mkdtempSync(join(folder, "set-")), "unseen.json")
  writeFileSync(path, JSON.stringify(unseen))
  return path
}

// The label of each member on each screenshot, in the order of `members`.
// A null label is a reply that is not JSON.
const script: Record<string, (string | null)[]> = {
  "new-agree": ["defect", "defect", "defect"],
  "new-split": ["defect", "fine", "defect"],
  "new-error": ["fine", "fine", null],
  "change-agree": ["regression", "regression", "regression"],
}
type Call = { model: string; prefix: string; story: string; images: number }
let calls: Call[] = []
const chat = http.post(`${gateway}/chat/completions`, async ({ request }) => {
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
  const id = /Story: (\S+)/.exec(story?.text ?? "")?.[1] ?? ""
  const label = script[id]?.[members.indexOf(body.model)]
  return HttpResponse.json({
    choices: [
      {
        message: {
          content: label
            ? JSON.stringify({ reason: `${body.model} on ${id}.`, label })
            : "I cannot tell.",
        },
      },
    ],
    usage: { cost: 0.02 },
  })
})

const run = async (extra: string[] = [], path = writeSet()) => {
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", gateway)
  const printed: string[] = []
  const code = await labelUnseen(
    [
      "--models",
      members.join(","),
      "--images",
      images,
      "--unseen",
      path,
      ...extra,
    ],
    (text) => printed.push(text),
  )
  const set = unseenSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  const byId = new Map(set.screenshots.map((one) => [one.id, one]))
  return { code, set, byId, path, text: printed.join("\n") }
}

test("the agreement rule of the unseen set: each member gives the label", () => {
  const votes = (...labels: ("defect" | "fine" | null)[]) =>
    labels.map((label) => ({ label }))
  expect(unanimous(votes("defect", "defect", "defect"))).toBe("defect")
  expect(unanimous(votes("fine", "fine", "fine"))).toBe("fine")
  // Two against one is not enough, and a failed vote leaves no label.
  expect(unanimous(votes("defect", "defect", "fine"))).toBeNull()
  expect(unanimous(votes("fine", "fine", null))).toBeNull()
  expect(unanimous(votes(null, null, null))).toBeNull()
})

test("a dry run labels each screenshot, and only a unanimous panel gives a label", async () => {
  calls = []
  server.use(chat)

  const { code, set, byId, text } = await run()

  expect(code).toBe(0)
  expect(calls).toHaveLength(3 * 4)
  // A screenshot with no earlier image gets the new-screenshot prompt of the
  // panel: one image, the labels defect and fine, the rubric, and not the
  // "how to judge" rule that comes from the feedback of the owner.
  const fresh = calls.find(({ story }) => story.includes("Story: new-agree\n"))
  expect(fresh?.images).toBe(1)
  expect(fresh?.prefix).toContain("`defect`")
  expect(fresh?.prefix).toContain("Rubric, layer 2, the design qualities")
  expect(fresh?.prefix).not.toContain("How to judge")
  expect(fresh?.story).toContain("A screenshot of main for a design review.")
  // A change gets the change prompt of the panel, with its brief and the
  // images of the compare engine.
  const changed = calls.find(({ story }) =>
    story.includes("Story: change-agree\n"),
  )
  expect(changed?.prefix).toContain("`no-change`")
  expect(changed?.story).toContain("Make the gray bar wider.")
  expect(changed?.images).toBeGreaterThan(1)
  // No member sees the vote of another one.
  for (const { prefix, story } of calls)
    expect(prefix + story).not.toContain("judge on")

  expect(set.panelModels).toEqual(members)
  expect(byId.get("new-agree")?.panel).toEqual({
    label: "defect",
    votes: members.map((model) => ({
      model,
      label: "defect",
      reason: `${model} on new-agree.`,
    })),
  })
  // The regression of a change is a defect.
  expect(byId.get("change-agree")?.panel?.label).toBe("defect")
  expect(byId.get("change-agree")?.panel?.votes[0]?.label).toBe("defect")
  // Two against one, or a failed vote: no label, so the screenshot does not
  // count for the score.
  expect(byId.get("new-split")?.panel?.label).toBeNull()
  expect(byId.get("new-error")?.panel?.label).toBeNull()
  expect(byId.get("new-error")?.panel?.votes[2]?.error).toContain("not JSON")

  expect(text).toContain("4 screenshots judged, $0.24 of the $15 cap.")
  expect(text).toContain(
    "All: 2 defect, 0 fine, 2 without agreement, 0 not judged.",
  )
  expect(text).toContain(
    "- main: 1 defect, 0 fine, 2 without agreement, 0 not judged.",
  )
  expect(text).toContain("- vendor-c/judge: 1 errors.")
})

test("a second run judges again only the screenshots with a failed vote", async () => {
  calls = []
  server.use(chat)
  const { path } = await run()
  script["new-error"] = ["fine", "fine", "fine"]
  calls = []

  const { code, byId } = await run([], path)

  expect(code).toBe(0)
  expect(calls).toHaveLength(3)
  expect(calls.every(({ story }) => story.includes("Story: new-error\n"))).toBe(
    true,
  )
  expect(byId.get("new-error")?.panel?.label).toBe("fine")
  expect(byId.get("new-agree")?.panel?.label).toBe("defect")
  script["new-error"] = ["fine", "fine", null]
})

test("the spend cap stops the panel before a call, and a screenshot without all votes gets no panel", async () => {
  calls = []
  server.use(chat)

  const { code, set, text } = await run(["--max-cost", "0"])

  expect(code).toBe(0)
  expect(calls).toHaveLength(0)
  expect(set.screenshots.every(({ panel }) => panel === undefined)).toBe(true)
  expect(text).toContain("The spend cap stopped the panel")
})

test("the votes of a set come from one panel", async () => {
  const path = writeSet()
  writeFileSync(
    path,
    JSON.stringify({ ...unseen, panelModels: ["x/one", "y/two", "z/three"] }),
  )
  calls = []
  server.use(chat)

  const { code, text } = await run([], path)

  expect(code).toBe(2)
  expect(calls).toHaveLength(0)
  expect(text).toContain("Use the same --models")
})

test("the committed unseen set matches the schema, and the owner did not review its stories", () => {
  const committed = unseenSchema.parse(
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, "unseen-calibration.json"),
        "utf8",
      ),
    ),
  )
  const owner = JSON.parse(
    readFileSync(join(import.meta.dirname, "owner-calibration.json"), "utf8"),
  ) as { screenshots: { path: string }[] }
  const story = (path: string) =>
    path
      .replace(/^.*\//, "")
      .replace(/\.(desktop|mobile)\.screenshot\.png$/, "")
  const reviewed = new Set(owner.screenshots.map(({ path }) => story(path)))

  expect(committed.screenshots.length).toBeGreaterThanOrEqual(50)
  expect(
    committed.screenshots.filter(({ path }) => reviewed.has(story(path))),
  ).toEqual([])
})
