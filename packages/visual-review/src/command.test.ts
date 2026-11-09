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
import { dirname, join } from "node:path"

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
import { z } from "zod"

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

// The parts of a chat request that the tests read.
type Chat = {
  model: string
  messages: { content: { type: string; text?: string }[] }[]
  response_format: { json_schema: { schema: object } }
}
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

// `root` is the run folder. `work` is the temporary folder of the system,
// where the agent judge makes its sessions.
let root: string
let work: string
let output: string[]
beforeEach(async () => {
  // The real paths: on macOS the temporary folder is behind a symbolic link.
  root = await realpath(await mkdtemp(join(tmpdir(), "visual-review-command-")))
  work = await realpath(await mkdtemp(join(tmpdir(), "visual-review-work-")))
  vi.stubEnv("TMPDIR", work)
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
  await rm(work, { recursive: true, force: true })
})

/** The session folder that the last call printed. */
const session = () => {
  const match = /--session (\S+)/.exec(output.join("\n"))
  if (!match?.[1]) throw new Error("No session in the output.")
  return match[1]
}

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
  test("writes a judgment request in a new session, then reads the verdict.json of the agent", async () => {
    const manifest = await writeRun(["button--primary"])

    const first = await run("--manifest", manifest, "--judge", "agent")

    expect(first).toBe(2)
    expect(chats).toHaveLength(0)
    const folder = join(session(), "button--primary.desktop")
    expect(folder.startsWith(join(work, "visual-review-"))).toBe(true)
    const request = await readFile(join(folder, "request.md"), "utf8")
    expect(request).toContain("Story: button--primary")
    expect(request).toContain("Write your reply as `verdict.json`")
    expect(request).toContain(
      `node ${join(import.meta.dirname, "command.ts")} --judge agent --manifest ${manifest} --session ${session()}`,
    )
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
    const sessionFolder = session()
    output = []
    const second = await run(
      "--manifest",
      manifest,
      "--judge",
      "agent",
      "--session",
      sessionFolder,
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
    const folder = session()
    await writeFile(
      join(folder, "button--primary.desktop", "verdict.json"),
      JSON.stringify({ verdict: "fine" }),
    )

    const code = await run(
      "--manifest",
      manifest,
      "--judge",
      "agent",
      "--session",
      folder,
    )

    expect(code).toBe(2)
    expect(output.join("\n")).toContain("does not match the schema")
  })

  test("a changed request removes the old verdict.json", async () => {
    const manifest = await writeRun(["button--primary"])
    await run("--manifest", manifest, "--judge", "agent")
    const folder = session()
    const verdict = join(folder, "button--primary.desktop", "verdict.json")
    await writeFile(verdict, JSON.stringify(regression))
    const brief = join(root, "brief.md")
    await writeFile(brief, "Make the primary button red.")

    const code = await run(
      "--manifest",
      manifest,
      "--judge",
      "agent",
      "--session",
      folder,
      "--brief",
      brief,
    )

    expect(code).toBe(2)
    expect(existsSync(verdict)).toBe(false)
  })
})

describe("the agent judge reads a verdict only from its own session", () => {
  test("a call without --session starts a new session and reads no verdict", async () => {
    const manifest = await writeRun(["button--primary"])
    await run("--manifest", manifest, "--judge", "agent")
    const first = session()
    await writeFile(
      join(first, "button--primary.desktop", "verdict.json"),
      JSON.stringify(intended),
    )
    output = []

    const code = await run("--manifest", manifest, "--judge", "agent")

    expect(code).toBe(2)
    expect(session()).not.toBe(first)
    expect(output.join("\n")).toContain("No agent verdict yet.")
  })

  test.each([
    ["a folder of the run", () => join(root, "session")],
    [
      "a folder of the temporary folder with another name",
      () => join(work, "planted"),
    ],
  ])("--session refuses %s", async (_, folderOf) => {
    const manifest = await writeRun(["button--primary"])
    const folder = folderOf()
    await mkdir(join(folder, "button--primary.desktop"), { recursive: true })

    const code = await run(
      "--manifest",
      manifest,
      "--judge",
      "agent",
      "--session",
      folder,
    )

    expect(code).toBe(2)
    expect(output.join("\n")).toContain(
      "is not a folder that visual:review made",
    )
  })

  test("--session refuses a session folder that other users can open", async () => {
    const manifest = await writeRun(["button--primary"])
    const folder = join(work, "visual-review-open")
    await mkdir(folder, { mode: 0o755 })

    const code = await run(
      "--manifest",
      manifest,
      "--judge",
      "agent",
      "--session",
      folder,
    )

    expect(code).toBe(2)
    expect(output.join("\n")).toContain(
      "is not a folder that visual:review made",
    )
  })
})

describe("visual:review reads only in the run folder", () => {
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

  test("a manifest that is a symbolic link is not read", async () => {
    const outside = await mkdtemp(join(tmpdir(), "visual-review-outside-"))
    await writeFile(join(outside, "secret.txt"), "secret text")
    await symlink(join(outside, "secret.txt"), join(root, "manifest.json"))

    const code = await run("--manifest", join(root, "manifest.json"))

    await rm(outside, { recursive: true, force: true })
    expect(code).toBe(2)
    expect(output.join("\n")).toContain("The manifest is a symbolic link")
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

    expect((await readdir(session())).sort()).toEqual([
      "button--primary.desktop",
      "button--primary.mobile",
      "button--primary@menu-open.desktop",
    ])
  })

  test("a snapshot name with a slash or a space gets a folder of its own in the session", async () => {
    const manifest = await writeRun(["button--primary"], (story) => ({
      ...story,
      snapshot: "../menu open",
    }))

    expect(await run("--manifest", manifest, "--judge", "agent")).toBe(2)

    const [folder, ...others] = await readdir(session())
    expect(others).toEqual([])
    expect(folder).toMatch(
      /^button--primary@\.\._menu_open\.desktop-[0-9a-f]{8}$/,
    )
    const request = await readFile(
      join(session(), folder ?? "", "request.md"),
      "utf8",
    )
    expect(request).toContain("Story: button--primary@../menu open.desktop")
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

// The review folder of the factory: `binary/base/<path>` and
// `binary/head/<path>`, with the paths after `--`. The command builds its
// own manifest from the two images; the factory gives it none.
describe("visual:review --images, for the factory", () => {
  const button =
    "apps/ui/src/components/screenshots/Button.Primary.desktop.screenshot.png"
  const link =
    "apps/ui/src/components/screenshots/Link.Primary.desktop.screenshot.png"
  let images: string
  beforeEach(() => {
    images = join(root, "binary")
  })
  async function put(side: "base" | "head", path: string, png: Uint8Array) {
    const file = join(images, side, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, png)
  }
  const verdicts = () =>
    verdictSchema
      .extend({ path: z.string() })
      .array()
      .parse(JSON.parse(output.join("\n")))

  describe("the scope comes from the story file in the checkout", () => {
    // The command runs in the merge-base tree. Here, a small checkout with
    // a page story and a component story.
    const home = process.cwd()
    beforeEach(async () => {
      const checkout = join(root, "checkout")
      const stories = join(checkout, "apps/ui/src/components")
      await mkdir(stories, { recursive: true })
      await writeFile(
        join(stories, "Button.stories.tsx"),
        `const meta = { title: "Pages/Button", tags: ["page"], parameters: { route: "/" } }
export default meta
export const Primary = { render: () => null }
export const Bare = { tags: ["!page"], render: () => null }
`,
      )
      await writeFile(
        join(stories, "Link.stories.tsx"),
        `const meta = { title: "Link" }
export default meta
export const Primary = { render: () => null }
`,
      )
      process.chdir(checkout)
    })
    afterEach(() => process.chdir(home))
    const scope = (index: number) =>
      /Scope: (\w+)/.exec(JSON.stringify(chats[index]))?.[1]

    test("a story with the page tag in its meta has the scope page", async () => {
      await put("base", button, before)
      await put("head", button, after)

      await run("--json", "--images", images, "--", button)

      expect(scope(0)).toBe("page")
      expect(verdicts()[0]?.summary).toBe(regression.summary)
    })

    test("a story that removes the page tag, and a story with no tag, have the scope component", async () => {
      const bare =
        "apps/ui/src/components/screenshots/Button.Bare@open.mobile.screenshot.png"
      for (const path of [bare, link]) {
        await put("base", path, before)
        await put("head", path, after)
      }

      await run("--json", "--images", images, "--", bare, link)

      expect([scope(0), scope(1)]).toEqual(["component", "component"])
      expect(verdicts().map(({ summary }) => summary)).toEqual([
        regression.summary,
        regression.summary,
      ])
    })

    test("a screenshot with no story file has the scope component, and its summary says so", async () => {
      const lost =
        "apps/ui/src/components/screenshots/Card.Primary.desktop.screenshot.png"
      await put("base", lost, before)
      await put("head", lost, after)

      await run("--json", "--images", images, "--", lost)

      expect(scope(0)).toBe("component")
      expect(verdicts()[0]?.summary).toBe(
        `${regression.summary} The scope is component: the story of this screenshot is not in apps/ui/src/components/Card.stories.tsx at the merge base, so the page-only qualities were not judged.`,
      )
    })
  })

  test("a changed screenshot gets a verdict with its path; a major regression gives exit code 1", async () => {
    await put("base", button, before)
    await put("head", button, after)

    const code = await run("--json", "--images", images, "--", button)

    expect(code).toBe(1)
    expect(chats).toHaveLength(1)
    expect(verdicts()).toMatchObject([
      { path: button, verdict: "regression", severity: "major" },
    ])
  })

  test("each path gets one verdict, in the order of the paths, and the brief can make a change intended", async () => {
    content = JSON.stringify(intended)
    for (const path of [button, link]) {
      await put("base", path, before)
      await put("head", path, after)
    }
    const brief = join(root, "brief.md")
    await writeFile(brief, "Make the primary button red.")

    const code = await run(
      "--json",
      "--brief",
      brief,
      "--images",
      images,
      "--",
      link,
      button,
    )

    expect(code).toBe(0)
    expect(verdicts()).toMatchObject([
      { path: link, verdict: "intended" },
      { path: button, verdict: "intended" },
    ])
  })

  test("a screenshot with a new size is judged, and the private image folder is gone after the run", async () => {
    await put("base", button, before)
    await put(
      "head",
      button,
      screenshot(400, 320, [
        {
          box: { x: 240, y: 180, width: 120, height: 60 },
          color: [37, 99, 235],
        },
      ]),
    )

    const code = await run("--json", "--images", images, "--", button)

    expect(code).toBe(1)
    expect(chats).toHaveLength(1)
    expect(verdicts()).toMatchObject([{ path: button, verdict: "regression" }])
    expect(await readdir(work)).toEqual([])
  })

  describe("a new screenshot is judged on its own against the rubric", () => {
    // The reply of the model on a new screenshot (newJudgementJsonSchema).
    const brokenNew = {
      observations: [
        {
          part: 1,
          seen: "A primary button. Its label runs past its right edge.",
        },
      ],
      verdict: "regression",
      severity: "major",
      confidence: 0.9,
      summary: "The label of the new button overflows its box.",
      qualities: [{ name: "clarity", rating: "fails", confidence: 0.8 }],
      findings: [
        {
          kind: "overflow",
          region: { x: 0.6, y: 0.6, width: 0.3, height: 0.2 },
          evidence: "The last letters of the label are outside the button.",
          rubricRef: "apps/ui/DESIGN.md › Focus / keyboard",
          explainedByBrief: false,
          suggestion: "Let the button grow with its label.",
        },
      ],
    }
    const goodNew = {
      observations: [{ part: 1, seen: "A card with a title and one button." }],
      verdict: "intended",
      severity: "none",
      confidence: 0.8,
      summary: "The new card follows the rubric, as the brief asks.",
      qualities: [{ name: "clarity", rating: "meets", confidence: 0.8 }],
      findings: [],
    }
    const sent = (index: number) => {
      const chat = chats[index]
      if (!chat) throw new Error(`No chat call ${index}.`)
      return chat
    }

    test("a broken new screenshot is a regression from one call with the head image, and it blocks", async () => {
      content = JSON.stringify(brokenNew)
      await put("head", button, after)

      const code = await run("--json", "--images", images, "--", button)

      expect(code).toBe(1)
      expect(chats).toHaveLength(1)
      const [prefix, story, ...attached] = sent(0).messages[0]?.content ?? []
      expect(prefix?.text).toMatch(/there is no base image/i)
      expect(prefix?.text).toMatch(/judge the screenshot on its own/i)
      expect(story?.text).toContain(
        "Image 1: the full new screenshot, 400 × 300",
      )
      expect(attached.map(({ type }) => type)).toEqual(["image_url"])
      expect(JSON.stringify(sent(0).response_format)).toContain('"rating"')
      expect(verdicts()).toMatchObject([
        {
          path: button,
          verdict: "regression",
          severity: "major",
          observations: [
            { region: 1, before: "", after: brokenNew.observations[0]?.seen },
          ],
          qualities: [{ name: "clarity", delta: "fails" }],
          findings: [{ kind: "overflow" }],
        },
      ])
    })

    test("the new screenshots of one story at two viewports are one call; a removed screenshot stays unsure with no call", async () => {
      content = JSON.stringify(goodNew)
      const card = "apps/ui/src/components/screenshots/Card.Primary"
      const desktop = `${card}.desktop.screenshot.png`
      const mobile = `${card}.mobile.screenshot.png`
      await put("head", desktop, after)
      await put("head", mobile, screenshot(390, 600, []))
      await put("base", link, before)
      const brief = join(root, "brief.md")
      await writeFile(brief, "Add a card for the new connector.")

      const code = await run(
        "--json",
        "--brief",
        brief,
        "--images",
        images,
        "--",
        desktop,
        link,
        mobile,
      )

      expect(code).toBe(0)
      expect(chats).toHaveLength(1)
      const parts = sent(0).messages[0]?.content ?? []
      expect(parts.filter(({ type }) => type === "image_url")).toHaveLength(2)
      expect(parts[1]?.text).toContain(
        "Image 2: the full new screenshot, 390 × 600",
      )
      expect(parts[1]?.text).toContain("Add a card for the new connector.")
      expect(verdicts()).toMatchObject([
        { path: desktop, verdict: "intended", costUsd: 0.01 },
        { path: link, verdict: "unsure", severity: "none", model: "none" },
        {
          path: mobile,
          verdict: "intended",
          groupedWith: desktop,
          costUsd: 0,
          findings: [],
        },
      ])
      expect(verdicts().every(({ error }) => error === undefined)).toBe(true)
    })

    test("a reply in the schema of a change is not usable for a new screenshot: exit code 2", async () => {
      await put("head", button, after)

      expect(await run("--json", "--images", images, "--", button)).toBe(2)
      expect(verdicts()[0]?.error).toContain("does not match the schema")
    })
  })

  describe("--budget-usd stops the model calls of the run", () => {
    const paths = ["One", "Two", "Three", "Four"].map(
      (name) =>
        `apps/ui/src/components/screenshots/Button.${name}.desktop.screenshot.png`,
    )
    beforeEach(async () => {
      for (const path of paths) {
        await put("base", path, before)
        await put("head", path, after)
      }
    })

    test("a budget that allows 2 calls makes 2 calls, and the rest is unsure with budget reached: exit code 2", async () => {
      // Each reply costs 0.01 USD: the third call would start at 0.02.
      const code = await run(
        "--json",
        "--budget-usd",
        "0.02",
        "--images",
        images,
        "--",
        ...paths,
      )

      expect(code).toBe(2)
      expect(chats).toHaveLength(2)
      const judged = verdicts()
      expect(judged.filter(({ error }) => !error)).toHaveLength(2)
      const rest = judged.filter(({ error }) => error)
      expect(rest).toHaveLength(2)
      for (const verdict of rest) {
        expect(verdict.verdict).toBe("unsure")
        expect(verdict.error).toMatch(
          /^Budget reached: the run spent 0\.0200 USD of its --budget-usd 0\.02/,
        )
      }
    })

    test("a reply with no cost counts as 0.25 USD", async () => {
      server.use(
        http.post(
          "https://openrouter.test/api/v1/chat/completions",
          async ({ request }) => {
            chats.push((await request.json()) as Chat)
            return HttpResponse.json({
              choices: [{ message: { role: "assistant", content } }],
            })
          },
        ),
      )

      const code = await run(
        "--json",
        "--budget-usd",
        "0.3",
        "--images",
        images,
        "--",
        ...paths,
      )

      expect(code).toBe(2)
      expect(chats).toHaveLength(2)
    })

    test("a budget of 0 makes no call, also for a new screenshot", async () => {
      const fresh =
        "apps/ui/src/components/screenshots/Card.Primary.desktop.screenshot.png"
      await put("head", fresh, after)

      const code = await run(
        "--json",
        "--budget-usd",
        "0",
        "--images",
        images,
        "--",
        paths[0] ?? "",
        fresh,
      )

      expect(code).toBe(2)
      expect(chats).toHaveLength(0)
      for (const { summary, error } of verdicts()) {
        expect(summary).toMatch(
          /^Budget reached: no model judged this screenshot\./,
        )
        expect(error).toMatch(/^Budget reached/)
      }
      expect(verdicts()).toHaveLength(2)
    })

    test("the Jev filter call counts: the explainer is not called after the budget is spent", async () => {
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
                Object.keys(body.questions).map((name) => [
                  name,
                  { type: "noul", noul: 0.9 },
                ]),
              ),
              usage: { cost: 0.003 },
            })
          },
        ),
      )

      const code = await run(
        "--json",
        "--filter",
        "jev",
        "--budget-usd",
        "0.001",
        "--images",
        images,
        "--",
        paths[0] ?? "",
      )

      expect(code).toBe(2)
      expect(decisions).toHaveLength(1)
      expect(chats).toHaveLength(0)
      expect(verdicts()[0]).toMatchObject({
        verdict: "unsure",
        costUsd: 0.003,
      })
      expect(verdicts()[0]?.error).toMatch(/^Budget reached/)
    })

    test.each([
      ["a budget that is not a number", ["--budget-usd", "five"]],
      ["a negative budget", ["--budget-usd", "-1"]],
      [
        "a budget with --judge agent",
        ["--judge", "agent", "--budget-usd", "1"],
      ],
    ])("%s is a usage error", async (_, args) => {
      expect(await run(...args)).toBe(2)
      expect(chats).toHaveLength(0)
      expect(output.join("\n")).toContain("Usage: pnpm visual:review")
    })
  })

  test("a screenshot within the pixel tolerance is noise, with no model call", async () => {
    await put("base", button, before)
    await put("head", button, before)

    const code = await run("--json", "--images", images, "--", button)

    expect(code).toBe(0)
    expect(chats).toHaveLength(0)
    expect(verdicts()).toMatchObject([
      { path: button, verdict: "noise", severity: "none" },
    ])
  })

  // The factory reads exit code 2 as an ERROR. A missing key must never
  // pass, also when no screenshot needs a model.
  test.each([
    ["a changed screenshot", before, after],
    ["a new screenshot", undefined, after],
    ["a removed screenshot", before, undefined],
    ["a screenshot in the tolerance", before, before],
  ])(
    "without MODEL_PROVIDER_API_KEY, %s stops the review with exit code 2",
    async (_, base, head) => {
      vi.stubEnv("MODEL_PROVIDER_API_KEY", "")
      if (base) await put("base", button, base)
      if (head) await put("head", button, head)

      expect(await run("--json", "--images", images, "--", button)).toBe(2)
      expect(output.join("\n")).toContain("Set MODEL_PROVIDER_API_KEY")
    },
  )

  test.each([
    ["a path with no image on either side", [button]],
    ["a path that leaves the folder", ["../outside.screenshot.png"]],
    ["an absolute path", ["/etc/hosts"]],
  ])("%s is an error: exit code 2", async (_, paths) => {
    await writeFile(join(root, "outside.screenshot.png"), before)
    await mkdir(join(images, "base"), { recursive: true })

    expect(await run("--json", "--images", images, "--", ...paths)).toBe(2)
    expect(chats).toHaveLength(0)
    expect(output.join("\n")).toContain(`Cannot read the image of ${paths[0]}`)
  })

  test("an image that is a symbolic link is an error: exit code 2", async () => {
    const outside = join(root, "outside.png")
    await writeFile(outside, before)
    await put("head", button, after)
    await mkdir(dirname(join(images, "base", button)), { recursive: true })
    await symlink(outside, join(images, "base", button))

    expect(await run("--json", "--images", images, "--", button)).toBe(2)
    expect(chats).toHaveLength(0)
    expect(output.join("\n")).toContain(`Cannot read the image of ${button}`)
  })

  test.each([
    ["--images with no path", ["--images", "binary"]],
    ["a path with no --images", ["--", "a.screenshot.png"]],
    [
      "--images with --manifest",
      ["--manifest", "m.json", "--images", "binary", "--", "a.png"],
    ],
    [
      "--images with --judge agent",
      ["--judge", "agent", "--images", "binary", "--", "a.png"],
    ],
  ])("%s is a usage error", async (_, args) => {
    expect(await run(...args)).toBe(2)
    expect(output.join("\n")).toContain("Usage: pnpm visual:review")
  })
})
