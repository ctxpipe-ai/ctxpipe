// `visual:review` on a real visual run: real screenshots, the real compare
// engine, real image files and a real manifest. Only the provider HTTP is
// faked.
import { existsSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

import { visualReview } from "./command.ts"
import { screenshot } from "./compare/fixtures.ts"
import {
  diff,
  verdictSchema,
  writeManifest,
  writeStoryImages,
  type ManifestStory,
} from "./index.ts"

const regression = {
  observations: [
    {
      region: 1,
      before: "A blue button.",
      after: "A red button with clipped text.",
    },
  ],
  verdict: "regression",
  severity: "major",
  confidence: 0.9,
  summary: "The button text is clipped.",
  qualities: [{ name: "clarity", delta: "worse", confidence: 0.8 }],
  findings: [
    {
      kind: "overflow",
      region: { x: 0.6, y: 0.6, width: 0.3, height: 0.2 },
      evidence: "The last letters of the label are cut.",
      rubricRef: "apps/ui/DESIGN.md › Overflow",
      explainedByBrief: false,
      suggestion: "Let the button grow with its label.",
    },
  ],
}
const intended = {
  observations: [{ region: 1, before: "A blue button.", after: "A red one." }],
  verdict: "intended",
  severity: "none",
  confidence: 0.8,
  summary: "The button is red, as the brief asks.",
  qualities: [],
  findings: [],
}

type Chat = { model: string }
const chats: Chat[] = []
let content = JSON.stringify(regression)
const server = setupServer(
  http.post(
    "https://openrouter.test/api/v1/chat/completions",
    async ({ request }) => {
      chats.push((await request.json()) as Chat)
      return HttpResponse.json({
        choices: [{ message: { role: "assistant", content } }],
        usage: { cost: 0.01 },
      })
    },
  ),
)
beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterAll(() => server.close())

let root: string
let output: string[]
beforeEach(async () => {
  // The real path: on macOS the temporary folder is behind a symbolic link.
  root = await realpath(await mkdtemp(join(tmpdir(), "visual-review-command-")))
  output = []
  chats.length = 0
  content = JSON.stringify(regression)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://openrouter.test/api/v1")
})
afterEach(async () => {
  vi.unstubAllEnvs()
  server.resetHandlers()
  await rm(root, { recursive: true, force: true })
})

const before = screenshot(400, 300, [
  { box: { x: 240, y: 180, width: 120, height: 60 }, color: [37, 99, 235] },
])
const after = screenshot(400, 300, [
  { box: { x: 240, y: 180, width: 120, height: 60 }, color: [220, 38, 38] },
])

/**
 * Write a visual run under `root`: `changed` stories whose button turned red,
 * and one unchanged story. Returns the manifest path.
 */
async function writeRun(
  changed: readonly string[],
  edit: (story: ManifestStory) => ManifestStory = (story) => story,
): Promise<string> {
  const comparison = await diff(before, after)
  if (comparison.status !== "changed") throw new Error(comparison.status)
  const story = (id: string): Omit<ManifestStory, "status" | "images"> => ({
    id,
    title: "Button",
    componentFile: "apps/ui/src/components/Button.stories.tsx",
    scope: "component",
    viewport: "desktop",
    snapshot: null,
    baseline: `apps/ui/src/components/screenshots/Button.${id}.desktop.screenshot.png`,
    maxDiffPixels: 10,
    size: comparison.size,
    diffPixels: comparison.diffPixels,
    regions: comparison.regions,
    severity: comparison.severity,
    summary: comparison.summary,
    signature: comparison.signature,
    omittedRegions: 0,
  })
  const stories: ManifestStory[] = [
    { ...story("button--unchanged"), status: "unchanged", images: {} },
  ]
  for (const id of changed) {
    const { images, omittedRegions } = await writeStoryImages(
      { root, dir: id },
      before,
      after,
      comparison,
    )
    stories.push(
      edit({ ...story(id), status: "changed", images, omittedRegions }),
    )
  }
  const path = join(root, "manifest.json")
  await writeManifest(path, {
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
      baseRef: "origin/main",
    },
    stories,
  })
  return path
}

const run = (...args: string[]) =>
  visualReview(args, (text) => output.push(text))

describe("visual:review --judge model", () => {
  test("a major regression blocks: exit code 1, with the verdict and its finding", async () => {
    const manifest = await writeRun(["button--primary"])

    const code = await run("--manifest", manifest)

    expect(code).toBe(1)
    expect(chats.map(({ model }) => model)).toEqual([
      "anthropic/claude-sonnet-5.5",
    ])
    const text = output.join("\n")
    expect(text).toContain(
      "BLOCKS regression major button--primary.desktop: The button text is clipped.",
    )
    expect(text).toContain("overflow at x 0.60, y 0.60")
    expect(text).toContain("1 stories reviewed; 1 verdict blocks.")
  })

  test("a group of stories with the same diff is 3 calls, and --json gives one verdict for each changed story", async () => {
    content = JSON.stringify(intended)
    const ids = ["a--one", "a--two", "a--three", "a--four", "a--five"]
    const manifest = await writeRun(ids)
    const brief = join(root, "brief.md")
    await writeFile(brief, "Make the primary button red.")

    const code = await run(
      "--manifest",
      manifest,
      "--brief",
      brief,
      "--model",
      "openai/gpt-6.1-sol",
      "--json",
    )

    expect(code).toBe(0)
    expect(chats).toHaveLength(3)
    expect(chats[0]?.model).toBe("openai/gpt-6.1-sol")
    const verdicts = verdictSchema.array().parse(JSON.parse(output.join("\n")))
    expect(verdicts.map(({ storyId }) => storyId)).toEqual(
      ids.map((id) => `${id}.desktop`),
    )
    expect(verdicts.every(({ verdict }) => verdict === "intended")).toBe(true)
    expect(verdicts.filter(({ groupedWith }) => groupedWith)).toHaveLength(2)
  })

  test("without a brief, a reply of intended is unsure, which does not block", async () => {
    content = JSON.stringify(intended)
    const manifest = await writeRun(["button--primary"])

    const code = await run("--manifest", manifest)

    expect(code).toBe(0)
    expect(output.join("\n")).toContain("unsure none button--primary")
  })

  test("--filter jev accepts a change that Jev finds explained and not worse, with no explainer call", async () => {
    const decisions: unknown[] = []
    server.use(
      http.post(
        "https://openrouter.test/api/alpha/decisions",
        async ({ request }) => {
          const body = (await request.json()) as {
            questions: Record<string, { type: string }>
          }
          decisions.push(body)
          return HttpResponse.json({
            model: "typesafe/jev-1.14",
            answers: Object.fromEntries(
              Object.entries(body.questions).map(([name, { type }]) => [
                name,
                type === "noul"
                  ? { type: "noul", noul: 0.01 }
                  : {
                      type: "choice",
                      probabilities: { better: 0.02, same: 0.97, worse: 0.01 },
                    },
              ]),
            ),
            usage: { cost: 0.003 },
          })
        },
      ),
    )
    const manifest = await writeRun(["button--primary"])
    const brief = join(root, "brief.md")
    await writeFile(brief, "Make the primary button red.")

    const code = await run(
      "--manifest",
      manifest,
      "--brief",
      brief,
      "--filter",
      "jev",
    )

    expect(code).toBe(0)
    expect(decisions).toHaveLength(1)
    expect(chats).toHaveLength(0)
    expect(output.join("\n")).toContain("intended none button--primary")
  })

  test("without MODEL_PROVIDER_API_KEY the review stops with exit code 2", async () => {
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "")
    const manifest = await writeRun(["button--primary"])

    const code = await run("--manifest", manifest)

    expect(code).toBe(2)
    expect(output.join("\n")).toContain("Set MODEL_PROVIDER_API_KEY")
  })
})

describe("visual:review --judge agent", () => {
  test("writes a judgment request, then reads the verdict.json of the agent", async () => {
    const manifest = await writeRun(["button--primary"])
    const folder = join(root, "judgments", "button--primary.desktop")

    const first = await run("--manifest", manifest, "--judge", "agent")

    expect(first).toBe(2)
    expect(chats).toHaveLength(0)
    const request = await readFile(join(folder, "request.md"), "utf8")
    expect(request).toContain("Story: button--primary")
    expect(request).toContain("Write your reply as `verdict.json`")
    for (const name of [
      "1-regions.png",
      "2-locator.png",
      "3-before.png",
      "4-after.png",
      "5-diff.png",
    ]) {
      expect(request).toContain(`- ${name}`)
      expect(existsSync(join(folder, name))).toBe(true)
    }
    expect(output.join("\n")).toContain(join(folder, "verdict.json"))

    await writeFile(join(folder, "verdict.json"), JSON.stringify(regression))
    output = []
    const second = await run(
      "--manifest",
      manifest,
      "--judge",
      "agent",
      "--json",
    )

    expect(second).toBe(1)
    const [verdict] = verdictSchema.array().parse(JSON.parse(output.join("\n")))
    expect(verdict).toMatchObject({
      storyId: "button--primary.desktop",
      verdict: "regression",
      severity: "major",
      model: "agent",
      costUsd: 0,
    })
    expect(chats).toHaveLength(0)
  })

  test("a verdict.json that does not match the schema leaves the review incomplete", async () => {
    const manifest = await writeRun(["button--primary"])
    await run("--manifest", manifest, "--judge", "agent")
    await writeFile(
      join(root, "judgments", "button--primary.desktop", "verdict.json"),
      JSON.stringify({ verdict: "fine" }),
    )

    const code = await run("--manifest", manifest, "--judge", "agent")

    expect(code).toBe(2)
    expect(output.join("\n")).toContain("does not match the schema")
  })

  test("a changed request removes the old verdict.json", async () => {
    const manifest = await writeRun(["button--primary"])
    await run("--manifest", manifest, "--judge", "agent")
    const verdict = join(
      root,
      "judgments",
      "button--primary.desktop",
      "verdict.json",
    )
    await writeFile(verdict, JSON.stringify(regression))
    const brief = join(root, "brief.md")
    await writeFile(brief, "Make the primary button red.")

    const code = await run(
      "--manifest",
      manifest,
      "--judge",
      "agent",
      "--brief",
      brief,
    )

    expect(code).toBe(2)
    expect(existsSync(verdict)).toBe(false)
  })
})

describe("visual:review reads and writes only in the run folder", () => {
  test("a judgments folder that links outside the run folder gets no write", async () => {
    const outside = await mkdtemp(join(tmpdir(), "visual-review-outside-"))
    await mkdir(join(outside, "button--primary.desktop"))
    await writeFile(join(outside, "button--primary.desktop", "keep.txt"), "x")
    const manifest = await writeRun(["button--primary"])
    await symlink(outside, join(root, "judgments"))

    const code = await run("--manifest", manifest, "--judge", "agent")

    const kept = await readdir(join(outside, "button--primary.desktop"))
    await rm(outside, { recursive: true, force: true })
    expect(code).toBe(2)
    expect(kept).toEqual(["keep.txt"])
    expect(output.join("\n")).toContain("is outside the manifest folder")
  })

  test.each([
    ["a ../ path", "../outside.png"],
    ["an absolute path", "/etc/hosts"],
  ])("a manifest with %s fails before a judge reads it", async (_, path) => {
    const manifest = await writeRun(["button--primary"], (story) => ({
      ...story,
      images: { ...story.images, after: path },
    }))

    const code = await run("--manifest", manifest)

    expect(code).toBe(2)
    expect(chats).toHaveLength(0)
    expect(output.join("\n")).toContain("is outside the manifest folder")
  })

  test("a verdict.json that links outside the run folder is not read", async () => {
    const outside = await mkdtemp(join(tmpdir(), "visual-review-outside-"))
    await writeFile(join(outside, "secret.txt"), "secret text")
    const manifest = await writeRun(["button--primary"])
    await run("--manifest", manifest, "--judge", "agent")
    await symlink(
      join(outside, "secret.txt"),
      join(root, "judgments", "button--primary.desktop", "verdict.json"),
    )
    output = []

    const code = await run("--manifest", manifest, "--judge", "agent")

    await rm(outside, { recursive: true, force: true })
    expect(code).toBe(2)
    expect(output.join("\n")).toContain("is outside the manifest folder")
    expect(output.join("\n")).not.toContain("secret text")
  })

  test("a symbolic link that points outside the run folder fails", async () => {
    const outside = await mkdtemp(join(tmpdir(), "visual-review-outside-"))
    await writeFile(join(outside, "secret.png"), after)
    const manifest = await writeRun(["button--primary"])
    await symlink(join(outside, "secret.png"), join(root, "link.png"))
    const edited = JSON.parse(await readFile(manifest, "utf8"))
    edited.stories[1].images.after = "link.png"
    await writeFile(manifest, JSON.stringify(edited))

    const code = await run("--manifest", manifest)

    await rm(outside, { recursive: true, force: true })
    expect(code).toBe(2)
    expect(chats).toHaveLength(0)
    expect(output.join("\n")).toContain("is outside the manifest folder")
  })
})

describe("visual:review checks each screenshot", () => {
  test("two viewports and a named snapshot of one story get a judgment request each", async () => {
    const manifest = await writeRun(["button--primary"])
    const edited = JSON.parse(await readFile(manifest, "utf8"))
    const [, desktop] = edited.stories
    edited.stories.push(
      { ...desktop, viewport: "mobile" },
      { ...desktop, snapshot: "menu-open" },
    )
    await writeFile(manifest, JSON.stringify(edited))

    expect(await run("--manifest", manifest, "--judge", "agent")).toBe(2)

    expect((await readdir(join(root, "judgments"))).sort()).toEqual([
      "button--primary.desktop",
      "button--primary.mobile",
      "button--primary@menu-open.desktop",
    ])
  })

  test("a changed story without its before and after images is a manifest error", async () => {
    const manifest = await writeRun(["button--primary"], (story) => ({
      ...story,
      images: {},
    }))

    expect(await run("--manifest", manifest)).toBe(2)
    expect(chats).toHaveLength(0)
    expect(output.join("\n")).toContain("has no before and after image")
  })
})

test("an unknown judge is a usage error", async () => {
  expect(await run("--judge", "human")).toBe(2)
  expect(output.join("\n")).toContain("Usage: pnpm visual:review")
})
