import {
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises"
import { join, posix } from "node:path"

import { decode, encode } from "@blazediff/codec-png-native"

import { diff } from "./diff.ts"
import { writeStoryImages } from "./images.ts"
import {
  baselinePath,
  manifestSchema,
  writeManifest,
  type Manifest,
  type ManifestStory,
} from "./manifest.ts"

type Viewport = "desktop" | "mobile"

/** A story entry of the Storybook index (`storybook-static/index.json`). */
export type IndexStory = {
  id: string
  title: string
  /** The story file, from `apps/ui`, for example `./src/x/Card.stories.tsx`. */
  importPath: string
  exportName: string
  tags?: string[]
}

/** The screenshot of one story at one viewport, from the capture container. */
export type Captured = {
  status: "captured" | "unstable" | "play-failed" | "capture-failed" | "not-run"
  png?: Uint8Array
  error?: string
}

/** Takes the screenshots of the stories `ids` at `viewport`, by story id. */
export type Capture = (
  viewport: Viewport,
  ids: string[],
) => Promise<Map<string, Captured>>

type Shot = {
  story: IndexStory
  storyFile: string
  scope: "page" | "component"
  viewport: Viewport
  baseline: string
}

const maxDiffPixels = 10

/**
 * `visual:check` and `visual:update` for the stories of one Storybook build.
 *
 * Every story has a desktop baseline; a story with the `page` tag also has a
 * mobile one. A story in `unstable` has no baseline yet: it is skipped. A
 * baseline file is an orphan when no story has it, also when its
 * `screenshots/` folder has no story file beside it.
 *
 * - `check` captures every story, compares each screenshot with its
 *   baseline, and writes the images of each story that is not unchanged and
 *   `manifest.json` into `out`. It never writes or deletes a baseline.
 * - `update` captures the selected stories (all, `only`, or with `failed`
 *   the stories of the last check that were not unchanged), writes each
 *   baseline that changed (recompressed without loss), and deletes the
 *   orphans.
 *
 * Both fail (return 1) when a baseline is above the size `budget`. `check`
 * also fails on each story that is not unchanged; `update` on each story with
 * no steady screenshot.
 */
export async function runVisual({
  mode,
  root,
  out,
  stories,
  unstable,
  capture,
  run,
  print,
  only,
  failed = false,
  budget = { total: 60 * 1024 * 1024, image: 1024 * 1024 },
}: {
  mode: "check" | "update"
  /** The repository root. */
  root: string
  /** The results folder, `.ci-results/visual`. */
  out: string
  stories: readonly IndexStory[]
  /** The known unstable stories (`scripts/ci/visual-unstable-stories.json`). */
  unstable: readonly { id: string; ticket: string }[]
  capture: Capture
  /** The facts of the run, for the manifest. */
  run: Manifest["run"]
  print: (line: string) => void
  /** Only with `update`: the story ids to accept. */
  only?: readonly string[]
  /** Only with `update`: accept the stories that the last check failed. */
  failed?: boolean
  /** The largest total size and the largest size of one image, in bytes. */
  budget?: { total: number; image: number }
}): Promise<number> {
  const skipped = new Map(unstable.map((entry) => [entry.id, entry.ticket]))
  const shots = stories.flatMap((story): Shot[] => {
    const storyFile = posix.join("apps/ui", story.importPath)
    const page = (story.tags ?? []).includes("page")
    return (
      page ? (["desktop", "mobile"] as const) : (["desktop"] as const)
    ).map((viewport) => ({
      story,
      storyFile,
      scope: page ? "page" : "component",
      viewport,
      baseline: baselinePath({
        storyFile,
        storyName: story.exportName,
        viewport,
      }),
    }))
  })
  for (const story of stories)
    if (skipped.has(story.id))
      print(`skipped: ${story.id} (known unstable, ${skipped.get(story.id)})`)
  // A `screenshots/` folder with no story file beside it holds only orphans:
  // no story gives a baseline in it.
  const expected = new Set(shots.map((shot) => shot.baseline))
  const orphans = (await baselineFiles(root))
    .filter((path) => !expected.has(path))
    .sort()

  let selected = shots.filter((shot) => !skipped.has(shot.story.id))
  if (mode === "update" && only) {
    const unknown = only.filter(
      (id) => !stories.some((story) => story.id === id),
    )
    if (unknown.length)
      throw new Error(`Not in the Storybook build: ${unknown.join(", ")}`)
    selected = selected.filter((shot) => only.includes(shot.story.id))
  } else if (mode === "update" && failed) {
    const last = manifestSchema.parse(
      JSON.parse(await readFile(join(out, "manifest.json"), "utf8")),
    )
    const failing = new Set(
      last.stories
        .filter((story) => !["unchanged", "removed"].includes(story.status))
        .map((story) => story.baseline),
    )
    selected = selected.filter((shot) => failing.has(shot.baseline))
  }

  const results = new Map<Shot, Captured>()
  for (const viewport of ["desktop", "mobile"] as const) {
    const group = selected.filter((shot) => shot.viewport === viewport)
    if (!group.length) continue
    const captured = await capture(
      viewport,
      group.map((shot) => shot.story.id),
    )
    for (const shot of group)
      results.set(shot, captured.get(shot.story.id) ?? { status: "not-run" })
  }

  let failures = 0
  if (mode === "check") {
    await rm(out, { recursive: true, force: true })
    const entries: ManifestStory[] = []
    for (const [shot, result] of results) {
      const entry = await compareShot(root, out, shot, result)
      if (entry.status !== "unchanged") {
        failures++
        print(`${entry.status}: ${shot.baseline}`)
      }
      entries.push(entry)
    }
    for (const orphan of orphans) {
      failures++
      print(`removed: ${orphan} (no story has this baseline)`)
      entries.push(removedEntry(orphan))
    }
    await writeManifest(join(out, "manifest.json"), {
      version: 1,
      run,
      stories: entries,
    })
    if (failures)
      print(
        `${failures} screenshots differ from their baselines. See ${join(out, "manifest.json")}. To accept the changes, run: pnpm visual:update --failed`,
      )
  } else {
    let written = 0
    for (const [shot, result] of results) {
      if (result.status !== "captured" || !result.png) {
        failures++
        print(
          `${result.status === "unstable" ? "unstable" : "play-failed"}: ${shot.story.id} at ${shot.viewport}; no baseline written${result.error ? ` (${result.error})` : ""}`,
        )
        continue
      }
      const path = join(root, shot.baseline)
      const old = await readFile(path).catch(() => null)
      if (
        old &&
        (await diff(old, result.png, { maxDiffPixels })).status === "unchanged"
      )
        continue
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, encode(decode(result.png), { compression: 12 }))
      written++
    }
    for (const orphan of orphans) {
      await rm(join(root, orphan), { force: true })
      // A folder that is now empty goes too.
      await rmdir(join(root, orphan, "..")).catch(() => undefined)
    }
    print(
      `${written} baselines written, ${orphans.length} orphan baselines deleted.`,
    )
  }

  const over = await overBudget(root, budget)
  for (const line of over) print(line)
  return failures || over.length ? 1 : 0
}

/** The manifest entry of one captured screenshot, with its images in `out`. */
async function compareShot(
  root: string,
  out: string,
  shot: Shot,
  result: Captured,
): Promise<ManifestStory> {
  const dir = posix.join(shot.story.id, shot.viewport)
  const base: ManifestStory = {
    id: shot.story.id,
    title: shot.story.title,
    componentFile: shot.storyFile,
    scope: shot.scope,
    viewport: shot.viewport,
    snapshot: null,
    baseline: shot.baseline,
    status: "new",
    maxDiffPixels,
    size: null,
    diffPixels: null,
    regions: [],
    severity: null,
    summary: null,
    signature: null,
    omittedRegions: 0,
    images: {},
  }
  const writeAfter = async (png: Uint8Array) => {
    await mkdir(join(out, dir), { recursive: true })
    await writeFile(join(out, dir, "after.png"), png)
    return { after: posix.join(dir, "after.png") }
  }
  if (result.status !== "captured" || !result.png)
    return {
      ...base,
      status: result.status === "unstable" ? "unstable" : "play-failed",
      summary: result.error ?? `The screenshot is ${result.status}.`,
      images: result.png ? await writeAfter(result.png) : {},
    }
  const old = await readFile(join(root, shot.baseline)).catch(() => null)
  if (!old)
    return {
      ...base,
      summary: "The story has no baseline.",
      images: await writeAfter(result.png),
    }
  const comparison = await diff(old, result.png, { maxDiffPixels })
  const { images, omittedRegions } = await writeStoryImages(
    { root: out, dir },
    old,
    result.png,
    comparison,
  )
  if (comparison.status === "size-changed")
    return {
      ...base,
      status: "size-changed",
      size: comparison.after,
      summary: comparison.summary,
      images,
    }
  return {
    ...base,
    status: comparison.status,
    size: comparison.size,
    diffPixels: comparison.diffPixels,
    regions: comparison.regions,
    severity: comparison.severity,
    summary: comparison.summary,
    signature: comparison.signature || null,
    omittedRegions,
    images,
  }
}

/** The manifest entry of a baseline that no story has. */
function removedEntry(baseline: string): ManifestStory {
  const name = posix.basename(baseline)
  const stem = name.split(".")[0] ?? name
  return {
    id: baseline,
    title: "",
    componentFile: posix.join(
      posix.dirname(baseline),
      "..",
      `${stem}.stories.tsx`,
    ),
    scope: "component",
    viewport: name.endsWith(".mobile.screenshot.png") ? "mobile" : "desktop",
    snapshot: null,
    baseline,
    status: "removed",
    maxDiffPixels,
    size: null,
    diffPixels: null,
    regions: [],
    severity: null,
    summary: "No story has this baseline.",
    signature: null,
    omittedRegions: 0,
    images: {},
  }
}

/** Each `screenshots/*.screenshot.png` under apps/ui/src. */
async function baselineFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(root, "apps/ui/src"), {
    recursive: true,
    withFileTypes: true,
  }).catch(() => [])
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".screenshot.png") &&
        posix.basename(entry.parentPath) === "screenshots",
    )
    .map((entry) =>
      posix.relative(root, posix.join(entry.parentPath, entry.name)),
    )
}

/** The size budget errors of the committed baselines. */
async function overBudget(
  root: string,
  budget: { total: number; image: number },
): Promise<string[]> {
  const errors: string[] = []
  let total = 0
  for (const path of await baselineFiles(root)) {
    const { size } = await stat(join(root, path))
    total += size
    if (size > budget.image)
      errors.push(
        `${path} is ${size} bytes; one image may be ${bytes(budget.image)}. Make the story smaller, or mask the content that does not compress.`,
      )
  }
  if (total > budget.total)
    errors.push(
      `The baselines are ${total} bytes in total; the budget is ${bytes(budget.total)}.`,
    )
  return errors
}

const bytes = (count: number) =>
  count % (1024 * 1024) === 0 ? `${count / (1024 * 1024)} MB` : `${count} bytes`
