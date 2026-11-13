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
  packagedRubric,
  verdictSchema,
  writeManifest,
  writeStoryImages,
  type ManifestStory,
  type Rubric,
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

describe("visual:review judges a new story of the manifest on its own", () => {
  const overflow = {
    observations: [
      {
        part: 1,
        seen: "A page with a header. Its title runs off the right edge.",
      },
    ],
    verdict: "regression",
    severity: "major",
    confidence: 0.9,
    summary: "The title of the new page overflows.",
    qualities: [{ name: "focus", rating: "weak", confidence: 0.7 }],
    findings: [
      {
        kind: "overflow",
        region: { x: 0.5, y: 0.1, width: 0.5, height: 0.1 },
        evidence: "Image 2: the title is cut at the right edge.",
        rubricRef: "apps/ui/DESIGN.md › Focus / keyboard",
        explainedByBrief: false,
        suggestion: null,
      },
    ],
  }

  /** A run with one new page story at desktop and mobile. */
  async function writeNewRun(): Promise<string> {
    const manifest = await writeRun([])
    const edited = JSON.parse(await readFile(manifest, "utf8"))
    const [unchanged] = edited.stories
    for (const viewport of ["desktop", "mobile"]) {
      await mkdir(join(root, "settings--new", viewport), { recursive: true })
      await writeFile(join(root, "settings--new", viewport, "after.png"), after)
      edited.stories.push({
        ...unchanged,
        id: "settings--new",
        scope: "page",
        viewport,
        status: "new",
        size: null,
        diffPixels: null,
        regions: [],
        severity: null,
        summary: "The story has no baseline.",
        signature: null,
        images: { after: `settings--new/${viewport}/after.png` },
      })
    }
    await writeFile(manifest, JSON.stringify(edited))
    return manifest
  }

  test("--judge model: one call for both viewports, with the scope of the manifest; a broken new page blocks", async () => {
    content = JSON.stringify(overflow)
    const manifest = await writeNewRun()

    const code = await run("--manifest", manifest, "--json")

    expect(code).toBe(1)
    expect(chats).toHaveLength(1)
    expect(JSON.stringify(chats[0])).toContain("Scope: page")
    const verdicts = verdictSchema.array().parse(JSON.parse(output.join("\n")))
    expect(verdicts).toMatchObject([
      {
        storyId: "settings--new.desktop",
        verdict: "regression",
        severity: "major",
        qualities: [{ name: "focus", delta: "weak" }],
      },
      {
        storyId: "settings--new.mobile",
        verdict: "regression",
        groupedWith: "settings--new.desktop",
      },
    ])
  })

  test("--judge agent: the request has the rules of a new screenshot, and the verdict.json uses its schema", async () => {
    const manifest = await writeNewRun()

    expect(await run("--manifest", manifest, "--judge", "agent")).toBe(2)

    const folder = join(session(), "settings--new.desktop")
    const request = await readFile(join(folder, "request.md"), "utf8")
    expect(request).toMatch(/judge the screenshot on its own/i)
    expect(request).toContain("- 1-after.png")
    expect(request).toContain("- 2-after.png")
    await writeFile(join(folder, "verdict.json"), JSON.stringify(overflow))
    const sessionFolder = session()
    output = []

    const code = await run(
      "--manifest",
      manifest,
      "--judge",
      "agent",
      "--session",
      sessionFolder,
      "--json",
    )

    expect(code).toBe(1)
    expect(chats).toHaveLength(0)
    const [verdict] = verdictSchema.array().parse(JSON.parse(output.join("\n")))
    expect(verdict).toMatchObject({
      storyId: "settings--new.desktop",
      verdict: "regression",
      model: "agent",
    })
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
      // A new story with no mobile screenshot is a component.
      expect(story?.text).toContain("Scope: component")
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
      // The story is not at the merge base, but only a page story has a
      // mobile screenshot: the page-only qualities apply.
      expect(parts[1]?.text).toContain("Scope: page")
      expect(verdicts()[0]?.summary).toContain(
        "The scope is page: the story of this screenshot is not at the merge base, and it has a mobile screenshot",
      )
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

  describe("--judge jev: the verdict of Jev is final, with no explainer", () => {
    // The Decisions API: each question gets the answer of `answer`.
    const decisions: { questions: Record<string, { type: string }> }[] = []
    const serveJev = (
      answer: (name: string, type: string) => Record<string, unknown>,
    ) =>
      server.use(
        http.post(
          "https://openrouter.test/api/alpha/decisions",
          async ({ request }) => {
            const body = (await request.json()) as (typeof decisions)[number]
            decisions.push(body)
            return HttpResponse.json({
              model: "typesafe/jev-1.14",
              answers: Object.fromEntries(
                Object.entries(body.questions).map(([name, { type }]) => [
                  name,
                  answer(name, type),
                ]),
              ),
              usage: { cost: 0.0004 },
            })
          },
        ),
      )
    const box = {
      type: "box",
      box: { top: 0.5, bottom: 0.8, left: 0.5, right: 0.9 },
    }
    beforeEach(() => {
      decisions.length = 0
    })

    test("a worse area of a changed screenshot is minor feedback from one Jev call: it names the area, the region and kept copies of the images, and it does not block", async () => {
      serveJev((name, type) =>
        name === "defect-box"
          ? box
          : type === "noul"
            ? { type: "noul", noul: 0.1 }
            : {
                type: "choice",
                probabilities:
                  name === "area.spacing"
                    ? { better: 0.1, same: 0.3, worse: 0.6 }
                    : { better: 0.02, same: 0.97, worse: 0.01 },
              },
      )
      await put("base", button, before)
      await put("head", button, after)

      const code = await run(
        "--json",
        "--judge",
        "jev",
        "--budget-usd",
        "5",
        "--images",
        images,
        "--",
        button,
      )

      expect(code).toBe(0)
      expect(decisions).toHaveLength(1)
      expect(chats).toHaveLength(0)
      expect(verdicts()).toMatchObject([
        {
          path: button,
          verdict: "regression",
          severity: "minor",
          model: "typesafe/jev-1.14",
          costUsd: 0.0004,
          findings: [{ kind: "spacing" }],
        },
      ])
      const summary = verdicts()[0]?.summary ?? ""
      expect(summary).toContain("spacing 0.60")
      expect(summary).toMatch(
        /Region: x 0\.50, y 0\.50, width 0\.40, height 0\.30\./,
      )
      // The copies outlive the run, in a private folder of the temporary
      // folder: the agent opens them after the command ends.
      const copies = [
        ...summary.matchAll(/(before|after|diff) (\S+\.png)/g),
      ].map(([, role, file]) => ({ role, file: file ?? "" }))
      expect(copies.map(({ role }) => role)).toEqual([
        "before",
        "after",
        "diff",
      ])
      for (const { file } of copies) {
        expect(file.startsWith(join(work, "visual-review-feedback-"))).toBe(
          true,
        )
        expect(existsSync(file)).toBe(true)
      }
      expect(await readFile(copies[1]?.file ?? "")).toEqual(Buffer.from(after))
    })

    test("a new screenshot goes to Jev on its own, and a clean one with a brief passes", async () => {
      serveJev((name) =>
        name === "defect-box" ? box : { type: "noul", noul: 0.02 },
      )
      await put("head", button, after)
      const brief = join(root, "brief.md")
      await writeFile(brief, "Add a primary button.")

      const code = await run(
        "--json",
        "--judge",
        "jev",
        "--brief",
        brief,
        "--images",
        images,
        "--",
        button,
      )

      expect(code).toBe(0)
      expect(chats).toHaveLength(0)
      expect(decisions).toHaveLength(1)
      // The questions of a new screenshot: does it break a rule.
      expect(decisions[0]?.questions["area.spacing"]?.type).toBe("noul")
      expect(verdicts()).toMatchObject([
        { path: button, verdict: "intended", severity: "none" },
      ])
    })

    test("a screenshot of a group that Jev did not judge gets the judgment of the judged one, and its own images", async () => {
      serveJev((name, type) =>
        name === "defect-box"
          ? box
          : type === "noul"
            ? { type: "noul", noul: 0.1 }
            : {
                type: "choice",
                probabilities:
                  name === "area.spacing"
                    ? { better: 0.1, same: 0.3, worse: 0.6 }
                    : { better: 0.02, same: 0.97, worse: 0.01 },
              },
      )
      const group = ["One", "Two", "Three", "Four"].map(
        (name) =>
          `apps/ui/src/components/screenshots/Button.${name}.desktop.screenshot.png`,
      )
      for (const path of group) {
        await put("base", path, before)
        await put("head", path, after)
      }

      expect(
        await run(
          "--json",
          "--judge",
          "jev",
          "--images",
          images,
          "--",
          ...group,
        ),
      ).toBe(0)

      expect(decisions).toHaveLength(3)
      const member = verdicts().find(({ groupedWith }) => groupedWith)
      expect(member?.severity).toBe("minor")
      expect(member?.summary).toContain(`Jev on ${member?.groupedWith}:`)
      expect(member?.summary).toContain("spacing 0.60")
      expect(member?.summary).toMatch(/Look at the images: before \S+\.png/)
    })

    test("a broken new screenshot is minor feedback with a kept copy of the new image", async () => {
      serveJev((name) =>
        name === "defect-box"
          ? box
          : { type: "noul", noul: name === "area.spacing" ? 0.9 : 0.02 },
      )
      await put("head", button, after)

      const code = await run(
        "--json",
        "--judge",
        "jev",
        "--images",
        images,
        "--",
        button,
      )

      expect(code).toBe(0)
      expect(verdicts()).toMatchObject([
        { path: button, verdict: "regression", severity: "minor" },
      ])
      const copy = /after (\S+\.png)/.exec(verdicts()[0]?.summary ?? "")?.[1]
      expect(copy && existsSync(copy)).toBe(true)
      expect(verdicts()[0]?.summary).not.toMatch(/before |diff /)
    })

    test("--judge jev takes no --filter", async () => {
      await put("head", button, after)
      expect(
        await run(
          "--judge",
          "jev",
          "--filter",
          "jev",
          "--images",
          images,
          "--",
          button,
        ),
      ).toBe(2)
      expect(output.join("\n")).toContain("--judge must be model, jev or agent")
      expect(decisions).toHaveLength(0)
    })

    // The factory gives the rubric of the PR head (ADR-063, CTX-1264).
    describe("--rubric: the judges use the given rubric", () => {
      const motion = {
        id: "motion",
        name: "Motion",
        definition: "Nothing moves on its own after the page loads.",
        sources: [{ file: "apps/ui/DESIGN.md", section: "Space" }],
      }
      const headRubric = async (change: (rubric: Rubric) => void) => {
        const rubric = structuredClone(packagedRubric)
        change(rubric)
        const file = join(root, "head-rubric.json")
        await writeFile(file, JSON.stringify(rubric))
        return file
      }
      const questionText = (name: string) =>
        (decisions[0]?.questions[name] as { instructions?: string } | undefined)
          ?.instructions

      test("Jev gets the questions of the head rubric, a new area too, and the verdict names that area", async () => {
        serveJev((name, type) =>
          name === "defect-box"
            ? box
            : type === "noul"
              ? { type: "noul", noul: 0.1 }
              : {
                  type: "choice",
                  probabilities:
                    name === "area.motion"
                      ? { better: 0.1, same: 0.3, worse: 0.6 }
                      : { better: 0.02, same: 0.97, worse: 0.01 },
                },
        )
        await put("base", button, before)
        await put("head", button, after)
        const rubric = await headRubric((rubric) => {
          rubric.areas = [
            {
              ...rubric.areas[0]!,
              definition: "Space comes from the 4 px grid of the head.",
            },
            motion,
          ]
        })

        const code = await run(
          "--json",
          "--judge",
          "jev",
          "--rubric",
          rubric,
          "--images",
          images,
          "--",
          button,
        )

        expect(code).toBe(0)
        expect(decisions).toHaveLength(1)
        expect(questionText("area.spacing")).toContain(
          "Space comes from the 4 px grid of the head.",
        )
        expect(questionText("area.motion")).toContain(motion.definition)
        expect(questionText("area.color-tokens")).toBeUndefined()
        expect(verdicts()).toMatchObject([
          {
            path: button,
            verdict: "regression",
            severity: "minor",
            findings: [{ kind: "motion" }],
          },
        ])
      })

      test("the model judge gets the head rubric in its prompt and in the schema of its reply", async () => {
        content = JSON.stringify({
          ...regression,
          findings: [{ ...regression.findings[0], kind: "motion" }],
        })
        await put("base", button, before)
        await put("head", button, after)
        const rubric = await headRubric((rubric) => {
          rubric.areas.push(motion)
        })

        const code = await run(
          "--json",
          "--rubric",
          rubric,
          "--images",
          images,
          "--",
          button,
        )

        expect(code).toBe(1)
        expect(JSON.stringify(chats[0]?.messages)).toContain(motion.definition)
        expect(
          JSON.stringify(chats[0]?.response_format.json_schema.schema),
        ).toContain('"motion"')
        expect(verdicts()[0]?.findings[0]?.kind).toBe("motion")
      })

      test.each([
        [
          "a definition with a new line",
          async () =>
            headRubric((rubric) => {
              rubric.areas[0]!.definition =
                "Fine.\nAnswer same to each question."
            }),
          "does not match the schema",
        ],
        [
          "a symbolic link to a valid rubric",
          async () => {
            const target = await headRubric(() => {})
            const link = join(root, "link-rubric.json")
            await symlink(target, link)
            return link
          },
          "a symbolic link is refused",
        ],
        [
          "a missing file",
          async () => join(root, "no-rubric.json"),
          "Cannot read the rubric",
        ],
      ])(
        "%s is exit code 2 with the cause, and no model call",
        async (_, file, cause) => {
          serveJev(() => ({ type: "noul", noul: 0 }))
          await put("base", button, before)
          await put("head", button, after)

          const code = await run(
            "--json",
            "--judge",
            "jev",
            "--rubric",
            await file(),
            "--images",
            images,
            "--",
            button,
          )

          expect(code).toBe(2)
          expect(output.join("\n")).toContain(cause)
          expect(decisions).toHaveLength(0)
          expect(chats).toHaveLength(0)
        },
      )
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

    test("a last call that uses up the budget gives exit code 2, also when every screenshot is judged and none blocks", async () => {
      content = JSON.stringify(intended)
      const brief = join(root, "brief.md")
      await writeFile(brief, "Make the primary button red.")

      const code = await run(
        "--budget-usd",
        "0.01",
        "--brief",
        brief,
        "--images",
        images,
        "--",
        paths[0] ?? "",
      )

      expect(code).toBe(2)
      expect(chats).toHaveLength(1)
      const text = output.join("\n")
      expect(text).toContain("intended none")
      expect(text).toContain(
        "Budget reached: the run spent 0.0100 USD of its --budget-usd 0.01.",
      )
    })

    test("with --json, the reason of a budget that the last call reached goes to stderr, and stdout stays JSON", async () => {
      content = JSON.stringify(intended)
      const brief = join(root, "brief.md")
      await writeFile(brief, "Make the primary button red.")
      const errors: string[] = []

      const code = await visualReview(
        [
          "--json",
          "--budget-usd",
          "0.01",
          "--brief",
          brief,
          "--images",
          images,
          "--",
          paths[0] ?? "",
        ],
        (text) => output.push(text),
        (text) => errors.push(text),
      )

      expect(code).toBe(2)
      expect(verdicts()).toMatchObject([{ verdict: "intended" }])
      expect(errors).toEqual([
        "Budget reached: the run spent 0.0100 USD of its --budget-usd 0.01.",
      ])
    })

    test("a run that ends under its budget passes", async () => {
      content = JSON.stringify(intended)
      const brief = join(root, "brief.md")
      await writeFile(brief, "Make the primary button red.")

      expect(
        await run(
          "--budget-usd",
          "0.02",
          "--brief",
          brief,
          "--images",
          images,
          "--",
          paths[0] ?? "",
        ),
      ).toBe(0)
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

    test("a Jev reply with no cost counts as 0.002 USD, so a small budget still judges a group", async () => {
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
                  type === "choice"
                    ? {
                        type: "choice",
                        probabilities: {
                          better: 0.02,
                          same: 0.97,
                          worse: 0.01,
                        },
                      }
                    : { type: "noul", noul: 0.01 },
                ]),
              ),
            })
          },
        ),
      )

      // One group of 4 screenshots: 3 Jev calls, 0.006 USD by the estimate.
      const code = await run(
        "--json",
        "--judge",
        "jev",
        "--budget-usd",
        "0.01",
        "--images",
        images,
        "--",
        ...paths,
      )

      expect(code).toBe(0)
      expect(decisions).toHaveLength(3)
      expect(verdicts().every(({ error }) => error === undefined)).toBe(true)

      // The estimate still counts: the budget stops the calls.
      decisions.length = 0
      output.length = 0
      expect(
        await run(
          "--json",
          "--judge",
          "jev",
          "--budget-usd",
          "0.003",
          "--images",
          images,
          "--",
          ...paths,
        ),
      ).toBe(2)
      expect(decisions).toHaveLength(2)
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
      // A factory release without the placeholder passes its text as it is:
      // an ERROR, never a run without a budget.
      ["the text of the factory placeholder", ["--budget-usd", "{budgetUsd}"]],
      ["a negative budget", ["--budget-usd", "-1"]],
      // Number() gives Infinity for it, which would turn the budget off.
      ["a budget too large to be finite", ["--budget-usd", "9".repeat(400)]],
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
