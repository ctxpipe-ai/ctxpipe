import { randomBytes } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { decode, encode } from "@blazediff/codec-png-native"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  runVisual,
  type Capture,
  type Captured,
  type IndexStory,
} from "./baselines.ts"
import { screenshot } from "./fixtures.ts"
import { manifestSchema, type Manifest } from "./manifest.ts"

const card: IndexStory = {
  id: "features-card--plain",
  title: "Features/Card",
  importPath: "./src/features/card/Card.stories.tsx",
  exportName: "Plain",
  tags: ["dev"],
}
const home: IndexStory = {
  id: "pages-home--default",
  title: "Pages/Home",
  importPath: "./src/routes/-home.stories.tsx",
  exportName: "Default",
  tags: ["dev", "page"],
}
const canvas: IndexStory = {
  id: "features-card--canvas",
  title: "Features/Card",
  importPath: "./src/features/card/Card.stories.tsx",
  exportName: "Canvas",
  tags: ["dev"],
}

const cardDesktop =
  "apps/ui/src/features/card/screenshots/Card.Plain.desktop.screenshot.png"
const homeDesktop =
  "apps/ui/src/routes/screenshots/-home.Default.desktop.screenshot.png"
const homeMobile =
  "apps/ui/src/routes/screenshots/-home.Default.mobile.screenshot.png"

const run: Manifest["run"] = {
  imageDigest: "sha256:abc",
  playwrightVersion: "1.63.0",
  viewports: {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 },
  },
  threshold: 0.1,
  commit: "0000000",
  baseRef: "0000000",
}

const page = (color: readonly [number, number, number]) =>
  screenshot(40, 30, [{ box: { x: 4, y: 4, width: 20, height: 10 }, color }])
const blue = page([0, 0, 255])
const red = page([255, 0, 0])
// Random pixels do not compress: about 1.5 MB as a PNG.
const noise = () =>
  encode({
    data: randomBytes(720 * 720 * 4).fill(255, 3, 4),
    width: 720,
    height: 720,
  })

let root: string
let out: string
let lines: string[]
// The screenshot of each `<id> <viewport>` that the fake container takes.
let shots: Map<string, Captured>
let captured: string[]

// The pinned container is the environment of the command: the fake gives
// the PNG of each shot (`<id>` or `<id>@<snapshot>`) from `shots`, and blue
// for any other shot.
const capture: Capture = async (viewport, stories) => {
  const keys = stories.flatMap((story) => [
    story.id,
    ...(story.visual?.snapshots ?? []).map((name) => `${story.id}@${name}`),
  ])
  captured.push(...keys.map((key) => `${key} ${viewport}`))
  return new Map(
    keys.map((key) => [
      key,
      shots.get(`${key} ${viewport}`) ?? { status: "captured", png: blue },
    ]),
  )
}

const runWith = (
  mode: "check" | "update",
  more: Partial<Parameters<typeof runVisual>[0]> = {},
) =>
  runVisual({
    mode,
    root,
    out,
    stories: [card, home, canvas],
    unstable: [{ id: canvas.id, ticket: "CTX-1" }],
    capture,
    run,
    print: (line) => lines.push(line),
    ...more,
  })
const visual = async (
  mode: "check" | "update",
  more: Partial<Parameters<typeof runVisual>[0]> = {},
) => (await runWith(mode, more)).code

const put = async (path: string, bytes: Uint8Array | string) => {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), bytes)
}

/** Every file under apps/ui with its bytes, to prove that a run wrote nothing. */
async function tree(): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(join(root, "apps/ui"), {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)
      files[path.slice(root.length + 1)] = (await readFile(path)).toString(
        "base64",
      )
    }
  return files
}

const manifest = async () =>
  manifestSchema.parse(
    JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
  )
const statuses = async () =>
  Object.fromEntries(
    (await manifest()).stories.map((story) => [story.baseline, story.status]),
  )

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visual-baselines-"))
  out = join(root, ".ci-results/visual")
  lines = []
  shots = new Map()
  captured = []
  await put("apps/ui/src/features/card/Card.stories.tsx", "export default {}")
  await put("apps/ui/src/routes/-home.stories.tsx", "export default {}")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("visual:check", () => {
  test("fails on a missing baseline and writes no baseline", async () => {
    const before = await tree()
    expect(await visual("check")).toBe(1)
    expect(await tree()).toEqual(before)
    expect(await statuses()).toEqual({
      [cardDesktop]: "new",
      [homeDesktop]: "new",
      [homeMobile]: "new",
    })
    const story = (await manifest()).stories.find(
      (entry) => entry.baseline === homeMobile,
    )
    expect(story).toMatchObject({
      id: home.id,
      scope: "page",
      viewport: "mobile",
      componentFile: "apps/ui/src/routes/-home.stories.tsx",
      images: { after: `${home.id}/mobile/after.png` },
    })
    expect(await readFile(join(out, `${home.id}/mobile/after.png`))).toEqual(
      Buffer.from(blue),
    )
  })

  test("captures every story at desktop, and a page story also at mobile", async () => {
    await visual("check")
    expect(captured.sort()).toEqual([
      `${card.id} desktop`,
      `${home.id} desktop`,
      `${home.id} mobile`,
    ])
  })

  test("skips a known unstable story and names its ticket", async () => {
    expect(await visual("update")).toBe(0)
    expect(await visual("check")).toBe(0)
    expect(captured.some((shot) => shot.startsWith(canvas.id))).toBe(false)
    expect(lines).toContain(
      `skipped: ${canvas.id} at desktop (known unstable, CTX-1)`,
    )
  })

  test("a baseline of a known unstable story is an orphan", async () => {
    await visual("update")
    const stale =
      "apps/ui/src/features/card/screenshots/Card.Canvas.desktop.screenshot.png"
    await put(stale, blue)
    expect(await visual("check")).toBe(1)
    expect(await statuses()).toMatchObject({ [stale]: "removed" })
    expect(await visual("update")).toBe(0)
    expect(Object.keys(await tree())).not.toContain(stale)
  })

  test("a known unstable entry with a viewport skips only that screenshot", async () => {
    const unstable = [
      { id: home.id, viewport: "mobile" as const, ticket: "CTX-2" },
    ]
    expect(await visual("check", { unstable })).toBe(1)
    expect(captured).not.toContain(`${home.id} mobile`)
    expect(captured).toContain(`${home.id} desktop`)
    expect(await statuses()).not.toHaveProperty(homeMobile)
    expect(lines).toContain(
      `skipped: ${home.id} at mobile (known unstable, CTX-2)`,
    )
  })

  test("fails on a changed baseline and writes no baseline", async () => {
    await visual("update")
    shots.set(`${card.id} desktop`, { status: "captured", png: red })
    const before = await tree()
    expect(await visual("check")).toBe(1)
    expect(await tree()).toEqual(before)
    expect(await statuses()).toMatchObject({
      [cardDesktop]: "changed",
      [homeDesktop]: "unchanged",
    })
    const story = (await manifest()).stories.find(
      (entry) => entry.baseline === cardDesktop,
    )
    expect(story?.images).toMatchObject({
      before: `${card.id}/desktop/before.png`,
      after: `${card.id}/desktop/after.png`,
      diff: `${card.id}/desktop/diff.png`,
    })
  })

  test("fails on an orphan baseline and on a screenshots folder with no story file, and deletes neither", async () => {
    await visual("update")
    const gone =
      "apps/ui/src/features/card/screenshots/Card.Gone.desktop.screenshot.png"
    const moved =
      "apps/ui/src/features/old/screenshots/Old.Plain.desktop.screenshot.png"
    await put(gone, blue)
    await put(moved, blue)
    const before = await tree()
    expect(await visual("check")).toBe(1)
    expect(await tree()).toEqual(before)
    expect(await statuses()).toMatchObject({
      [gone]: "removed",
      [moved]: "removed",
    })
  })

  test("fails on an unstable or a failed story", async () => {
    await visual("update")
    shots.set(`${card.id} desktop`, { status: "unstable", png: red })
    shots.set(`${home.id} mobile`, {
      status: "play-failed",
      error: "expected 2",
    })
    expect(await visual("check")).toBe(1)
    expect(await statuses()).toMatchObject({
      [cardDesktop]: "unstable",
      [homeMobile]: "play-failed",
    })
  })

  test("fails on an image of another size", async () => {
    await visual("update")
    shots.set(`${card.id} desktop`, {
      status: "captured",
      png: screenshot(40, 31, []),
    })
    expect(await visual("check")).toBe(1)
    expect(await statuses()).toMatchObject({ [cardDesktop]: "size-changed" })
  })

  test("an orphan of a story file with a dot in its name names that story file", async () => {
    const orphan =
      "apps/ui/src/features/card/screenshots/-github.link.Gone.desktop.screenshot.png"
    await put(orphan, blue)
    await visual("check")
    const story = (await manifest()).stories.find(
      (entry) => entry.baseline === orphan,
    )
    expect(story?.componentFile).toBe(
      "apps/ui/src/features/card/-github.link.stories.tsx",
    )
  })

  test("a screenshot file outside a screenshots folder is an orphan", async () => {
    await visual("update")
    const stray = "apps/ui/src/features/card/Card.Plain.desktop.screenshot.png"
    const far = "apps/ui/public/old.screenshot.png"
    await put(stray, blue)
    await put(far, blue)
    expect(await visual("check")).toBe(1)
    expect(await statuses()).toMatchObject({
      [stray]: "removed",
      [far]: "removed",
    })
    expect(await visual("update")).toBe(0)
    expect(Object.keys(await tree())).not.toContain(stray)
    expect(Object.keys(await tree())).not.toContain(far)
  })

  test("with only, compares the named stories and returns their entries, with no orphan and no total budget", async () => {
    await visual("update")
    await put(
      "apps/ui/src/features/card/screenshots/Card.Gone.desktop.screenshot.png",
      blue,
    )
    shots.set(`${home.id} mobile`, { status: "captured", png: red })
    captured = []
    const result = await runWith("check", {
      only: [home.id],
      budget: { total: 100, image: 1024 * 1024 },
    })
    expect(captured.sort()).toEqual([`${home.id} desktop`, `${home.id} mobile`])
    expect(result.code).toBe(1)
    expect(
      result.stories.map((story) => [story.baseline, story.status]),
    ).toEqual([
      [homeDesktop, "unchanged"],
      [homeMobile, "changed"],
    ])
    expect(result.budget).toEqual([])
    expect(await statuses()).toEqual({
      [homeDesktop]: "unchanged",
      [homeMobile]: "changed",
    })
  })

  test("the shards of a full check compare each story once; the first one also finds the orphans and the total size", async () => {
    await visual("update")
    const gone =
      "apps/ui/src/features/card/screenshots/Card.Gone.desktop.screenshot.png"
    await put(gone, blue)
    const budget = { total: 100, image: 1024 * 1024 }
    const shard = async (at: number) => {
      captured = []
      const result = await runWith("check", { shard: { at, count: 2 }, budget })
      return { result, captured: [...captured].sort() }
    }
    // By story id: canvas (known unstable), card, home. The shard of 2 holds
    // every second one.
    const first = await shard(1)
    expect(first.captured).toEqual([`${home.id} desktop`, `${home.id} mobile`])
    expect(
      first.result.stories.map((story) => [story.baseline, story.status]),
    ).toEqual([
      [homeDesktop, "unchanged"],
      [homeMobile, "unchanged"],
      [gone, "removed"],
    ])
    expect(first.result.budget).toEqual([
      { message: expect.stringMatching(/in total/) },
    ])
    expect(first.result.code).toBe(1)
    const second = await shard(2)
    expect(second.captured).toEqual([`${card.id} desktop`])
    expect(second.result).toMatchObject({ code: 0, budget: [] })
    expect(
      second.result.stories.map((story) => [story.baseline, story.status]),
    ).toEqual([[cardDesktop, "unchanged"]])
  })

  test("a shard is only a part of a full check", async () => {
    for (const more of [
      { mode: "update" as const, shard: { at: 1, count: 2 } },
      { mode: "check" as const, shard: { at: 1, count: 2 }, only: [home.id] },
      { mode: "check" as const, shard: { at: 3, count: 2 } },
      { mode: "check" as const, shard: { at: 0, count: 2 } },
    ])
      await expect(runWith(more.mode, more)).rejects.toThrow(
        /A shard is one part/,
      )
  })

  test("with only, a named story's baseline above the image budget fails and is named", async () => {
    shots.set(`${card.id} desktop`, { status: "captured", png: noise() })
    await visual("update")
    await visual("update", { only: [home.id] })
    const result = await runWith("check", { only: [home.id] })
    expect(result).toMatchObject({ code: 0, budget: [] })
    const big = await runWith("check", { only: [card.id] })
    expect(big.code).toBe(1)
    expect(big.budget).toEqual([
      { path: cardDesktop, message: expect.stringMatching(/1 MB/) },
    ])
  })
})

describe("visual:update", () => {
  test("--failed with no earlier check asks for visual:check first", async () => {
    await expect(visual("update", { failed: true })).rejects.toThrow(
      /Run pnpm visual:check first/,
    )
  })
  test("writes each missing baseline, recompressed without loss", async () => {
    expect(await visual("update")).toBe(0)
    for (const path of [cardDesktop, homeDesktop, homeMobile])
      expect(decode(await readFile(join(root, path)))).toEqual(decode(blue))
    expect(await visual("check")).toBe(0)
  })

  test("--failed accepts the changed stories of the last check, and only them", async () => {
    await visual("update")
    shots.set(`${card.id} desktop`, { status: "captured", png: red })
    await visual("check")
    captured = []
    expect(await visual("update", { failed: true })).toBe(0)
    expect(captured).toEqual([`${card.id} desktop`])
    expect(decode(await readFile(join(root, cardDesktop)))).toEqual(decode(red))
    expect(await visual("check")).toBe(0)
  })

  test("--only accepts the named stories, and only them", async () => {
    await visual("update")
    shots.set(`${card.id} desktop`, { status: "captured", png: red })
    shots.set(`${home.id} desktop`, { status: "captured", png: red })
    captured = []
    expect(await visual("update", { only: [home.id] })).toBe(0)
    expect(captured.sort()).toEqual([`${home.id} desktop`, `${home.id} mobile`])
    expect(decode(await readFile(join(root, homeDesktop)))).toEqual(decode(red))
    expect(decode(await readFile(join(root, cardDesktop)))).toEqual(
      decode(blue),
    )
  })

  test("--only refuses a story id that is not in the build", async () => {
    await expect(
      visual("update", { only: ["features-card--nothing"] }),
    ).rejects.toThrow(/features-card--nothing/)
  })

  test("keeps a baseline that is within the tolerance", async () => {
    await visual("update")
    const before = await tree()
    expect(await visual("update")).toBe(0)
    expect(await tree()).toEqual(before)
  })

  test("deletes an orphan baseline and a screenshots folder with no story file", async () => {
    await visual("update")
    await put(
      "apps/ui/src/features/card/screenshots/Card.Gone.desktop.screenshot.png",
      blue,
    )
    await put(
      "apps/ui/src/features/old/screenshots/Old.Plain.desktop.screenshot.png",
      blue,
    )
    expect(await visual("update", { only: [card.id] })).toBe(0)
    expect(Object.keys(await tree()).sort()).toEqual(
      [
        "apps/ui/src/features/card/Card.stories.tsx",
        cardDesktop,
        "apps/ui/src/routes/-home.stories.tsx",
        homeDesktop,
        homeMobile,
      ].sort(),
    )
    expect(await visual("check")).toBe(0)
  })

  test("writes no baseline for an unstable or a failed story", async () => {
    shots.set(`${card.id} desktop`, { status: "unstable", png: red })
    shots.set(`${home.id} mobile`, { status: "play-failed", error: "boom" })
    expect(await visual("update")).toBe(1)
    expect(Object.keys(await tree())).toContain(homeDesktop)
    expect(Object.keys(await tree())).not.toContain(cardDesktop)
    expect(Object.keys(await tree())).not.toContain(homeMobile)
  })
})

describe("the screenshot options of a story", () => {
  const menu: IndexStory = {
    id: "features-card--menu",
    title: "Features/Card",
    importPath: "./src/features/card/Card.stories.tsx",
    exportName: "Menu",
    tags: ["dev"],
    visual: { snapshots: ["menu-open", "saved"] },
  }
  const menuPath = (name: string) =>
    `apps/ui/src/features/card/screenshots/Card.${name}.desktop.screenshot.png`

  test("a story with two named snapshots gives a baseline for each, beside the end state", async () => {
    shots.set(`${menu.id}@menu-open desktop`, {
      status: "captured",
      png: red,
    })
    expect(await visual("update", { stories: [menu] })).toBe(0)
    expect(captured).toEqual([
      `${menu.id} desktop`,
      `${menu.id}@menu-open desktop`,
      `${menu.id}@saved desktop`,
    ])
    expect(decode(await readFile(join(root, menuPath("Menu"))))).toEqual(
      decode(blue),
    )
    expect(
      decode(await readFile(join(root, menuPath("Menu@menu-open")))),
    ).toEqual(decode(red))
    expect(decode(await readFile(join(root, menuPath("Menu@saved"))))).toEqual(
      decode(blue),
    )
    expect(await visual("check", { stories: [menu] })).toBe(0)
  })

  test("a changed named snapshot fails only its own baseline, and names the snapshot", async () => {
    await visual("update", { stories: [menu] })
    shots.set(`${menu.id}@saved desktop`, { status: "captured", png: red })
    expect(await visual("check", { stories: [menu] })).toBe(1)
    expect(await statuses()).toEqual({
      [menuPath("Menu")]: "unchanged",
      [menuPath("Menu@menu-open")]: "unchanged",
      [menuPath("Menu@saved")]: "changed",
    })
    const story = (await manifest()).stories.find(
      (entry) => entry.baseline === menuPath("Menu@saved"),
    )
    expect(story).toMatchObject({
      id: menu.id,
      snapshot: "saved",
      images: { after: `${menu.id}/@saved/desktop/after.png` },
    })
    expect(await visual("update", { stories: [menu], failed: true })).toBe(0)
    expect(await visual("check", { stories: [menu] })).toBe(0)
  })

  test("the baseline of a snapshot that the play no longer takes is an orphan", async () => {
    await visual("update", { stories: [menu] })
    const fewer = { ...menu, visual: { snapshots: ["saved"] } }
    expect(await visual("check", { stories: [fewer] })).toBe(1)
    const orphan = (await manifest()).stories.find(
      (entry) => entry.status === "removed",
    )
    expect(orphan).toMatchObject({
      baseline: menuPath("Menu@menu-open"),
      snapshot: "menu-open",
      componentFile: "apps/ui/src/features/card/Card.stories.tsx",
    })
    expect(await visual("update", { stories: [fewer] })).toBe(0)
    expect(Object.keys(await tree())).not.toContain(menuPath("Menu@menu-open"))
  })

  test("viewports replaces the default viewports", async () => {
    const stories = [
      { ...card, visual: { viewports: ["desktop", "mobile"] } },
      { ...home, visual: { viewports: ["desktop"] } },
    ] satisfies IndexStory[]
    expect(await visual("update", { stories })).toBe(0)
    expect(captured.sort()).toEqual([
      `${card.id} desktop`,
      `${card.id} mobile`,
      `${home.id} desktop`,
    ])
    expect(Object.keys(await tree())).toContain(
      "apps/ui/src/features/card/screenshots/Card.Plain.mobile.screenshot.png",
    )
    expect(Object.keys(await tree())).not.toContain(homeMobile)
  })

  test("maxDiffPixels sets the tolerance of the story", async () => {
    // The red box is 20 x 10 pixels: 200 pixels differ from blue.
    const stories = [{ ...card, visual: { maxDiffPixels: 200 } }, home]
    await visual("update", { stories })
    shots.set(`${card.id} desktop`, { status: "captured", png: red })
    shots.set(`${home.id} desktop`, { status: "captured", png: red })
    expect(await visual("check", { stories })).toBe(1)
    expect(await statuses()).toMatchObject({
      [cardDesktop]: "unchanged",
      [homeDesktop]: "changed",
    })
    const entry = (await manifest()).stories.find(
      (story) => story.baseline === cardDesktop,
    )
    expect(entry).toMatchObject({ maxDiffPixels: 200, diffPixels: 200 })
  })
})

describe("the size budget", () => {
  test("fails on one image above 1 MB", async () => {
    shots.set(`${card.id} desktop`, { status: "captured", png: noise() })
    expect(await visual("update")).toBe(1)
    expect(lines.join("\n")).toMatch(
      new RegExp(`${cardDesktop} is [\\d.]+ MB; one image may be 1 MB`),
    )
    expect(await visual("check")).toBe(1)
  })

  test("fails above the total size", async () => {
    await visual("update")
    const budget = { total: 100, image: 1024 * 1024 }
    expect(await visual("check", { budget })).toBe(1)
    expect(lines.join("\n")).toMatch(
      /The baselines are [\d.]+ MB in total; the budget is 0\.0000954 MB/,
    )
  })
})
