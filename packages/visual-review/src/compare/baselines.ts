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
  /** The screenshot options of the story (`parameters.visual`). */
  visual?: VisualOptions
}

/**
 * The screenshot options of a story, from `parameters.visual` and the
 * `snapshot()` calls of its play (scripts/checks/visual.mjs, visualOptions).
 */
export type VisualOptions = {
  /** The count of pixels that may differ. Default 10. */
  maxDiffPixels?: number
  /** Default desktop, and mobile too for a story with the `page` tag. */
  viewports?: Viewport[]
  /** The names of the named snapshots of the play. */
  snapshots?: string[]
  /** The capture applies these; the compare does not read them. */
  fullPage?: boolean
  masks?: string[]
  /** The layout rules that the story accepts, each with its reason. */
  allow?: Partial<Record<"overflow" | "axes" | "contrast", string>>
}

/**
 * One screenshot of one story at one viewport, from the capture container:
 * the end state, or a named snapshot.
 */
export type Captured = {
  status: "captured" | "unstable" | "play-failed" | "capture-failed" | "not-run"
  png?: Uint8Array
  error?: string
  /** The problems of the layout checks in the page of the screenshot. */
  layout?: ManifestStory["layout"]
}

/**
 * Takes the screenshots of `stories` at `viewport`. The key of a screenshot is
 * the story id, or `<story id>@<name>` for a named snapshot.
 */
export type Capture = (
  viewport: Viewport,
  stories: IndexStory[],
) => Promise<Map<string, Captured>>

type Shot = {
  story: IndexStory
  storyFile: string
  scope: "page" | "component"
  viewport: Viewport
  snapshot: string | null
  maxDiffPixels: number
  baseline: string
}

/** The default count of pixels that may differ. */
const maxDiffPixels = 10

const shotKey = (shot: Shot) =>
  shot.snapshot ? `${shot.story.id}@${shot.snapshot}` : shot.story.id

/**
 * `visual:check` and `visual:update` for the stories of one Storybook build.
 *
 * Every story has a desktop baseline; a story with the `page` tag also has a
 * mobile one. `story.visual.viewports` replaces these viewports. Each named
 * snapshot of `story.visual.snapshots` has a baseline at each viewport too.
 * A screenshot in `unstable` (a story id, at each viewport or at
 * one) has no baseline yet: it is skipped, and its old baseline is an
 * orphan. A `*.screenshot.png` file under apps/ui is an orphan when no story
 * has it. This is also true when its `screenshots/` folder has no story file
 * beside it, and when the file is not in a `screenshots/` folder.
 *
 * - `check` captures every story (or only the stories of `only`), compares
 *   each screenshot with its baseline, and writes the images of each story
 *   that is not unchanged and `manifest.json` into `out`. It never writes or
 *   deletes a baseline. With `only` (the visual checks of
 *   scripts/checks/visual.mjs), it does not look for orphans, and only the
 *   image budget of the baselines of those stories applies. With `shard`
 *   (one job of a full run in CI), it checks every `count`-th story by id,
 *   from the `at`-th: the shards together check each story once. Each shard
 *   checks the image budget of its own baselines, and the first shard also
 *   looks for orphans and checks the total size.
 * - `update` captures the selected stories (all, `only`, or with `failed`
 *   the stories of the last check that were not unchanged), writes each
 *   baseline that changed (recompressed without loss), and deletes the
 *   orphans.
 *
 * Both fail (code 1) when a baseline is above the size `budget`. `check`
 * also fails on each story that is not unchanged or that has a layout
 * problem (`Captured.layout`); `update` on each story with no steady
 * screenshot. Both print each layout problem. The result also holds the manifest entries of a
 * `check`, and each budget error with the baseline that it names.
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
  shard,
  failed = false,
  budget = { total: 60 * 1024 * 1024, image: 1024 * 1024 },
}: {
  mode: "check" | "update"
  /** The repository root. */
  root: string
  /** The results folder, `.ci-results/visual`. */
  out: string
  stories: readonly IndexStory[]
  /**
   * The known unstable stories (`scripts/ci/visual-unstable-stories.json`).
   * An entry with a viewport skips only the screenshot at that viewport.
   */
  unstable: readonly { id: string; ticket: string; viewport?: Viewport }[]
  capture: Capture
  /** The facts of the run, for the manifest. */
  run: Manifest["run"]
  print: (line: string) => void
  /** The story ids to compare (`check`) or to accept (`update`). */
  only?: readonly string[]
  /** Only with `check` and without `only`: one shard of a full run. */
  shard?: { at: number; count: number }
  /** Only with `update`: accept the stories that the last check failed. */
  failed?: boolean
  /** The largest total size and the largest size of one image, in bytes. */
  budget?: { total: number; image: number }
}): Promise<{
  code: 0 | 1
  /** The manifest entries of a `check`; empty for an `update`. */
  stories: ManifestStory[]
  budget: BudgetError[]
}> {
  if (
    shard &&
    (mode !== "check" ||
      only ||
      !(
        Number.isInteger(shard.at) &&
        Number.isInteger(shard.count) &&
        shard.at >= 1 &&
        shard.at <= shard.count
      ))
  )
    throw new Error(
      `A shard is one part of a full check: at and count are integers with 1 <= at <= count (got ${shard.at}/${shard.count}, mode ${mode}${only ? ", with only" : ""}).`,
    )
  // The story ids that this run compares or accepts; undefined for all.
  const subset =
    only ??
    (shard &&
      stories
        .map((story) => story.id)
        .sort()
        .filter((_, position) => position % shard.count === shard.at - 1))
  const shots = stories.flatMap((story): Shot[] => {
    const storyFile = posix.join("apps/ui", story.importPath)
    const page = (story.tags ?? []).includes("page")
    const viewports =
      story.visual?.viewports ??
      (page ? (["desktop", "mobile"] as const) : (["desktop"] as const))
    return viewports.flatMap((viewport) =>
      [null, ...(story.visual?.snapshots ?? [])].map((snapshot) => ({
        story,
        storyFile,
        scope: page ? "page" : "component",
        viewport,
        snapshot,
        maxDiffPixels: story.visual?.maxDiffPixels ?? maxDiffPixels,
        baseline: baselinePath({
          storyFile,
          storyName: story.exportName,
          ...(snapshot && { snapshot }),
          viewport,
        }),
      })),
    )
  })
  const ticketOf = (shot: Shot) =>
    unstable.find(
      (entry) =>
        entry.id === shot.story.id &&
        (entry.viewport ?? shot.viewport) === shot.viewport,
    )?.ticket
  for (const shot of shots) {
    const ticket = ticketOf(shot)
    if (ticket && (!subset || subset.includes(shot.story.id)))
      print(
        `skipped: ${shot.story.id} at ${shot.viewport} (known unstable, ${ticket})`,
      )
  }
  // A `screenshots/` folder with no story file beside it holds only orphans:
  // no story gives a baseline in it. A known unstable screenshot has no
  // baseline yet, so its old baseline is an orphan too.
  const expected = new Set(
    shots.filter((shot) => !ticketOf(shot)).map((shot) => shot.baseline),
  )
  // A check of some stories does not look at the files of other stories;
  // the first shard of a full run looks for the orphans of all of them.
  const orphans =
    mode === "check" && subset && shard?.at !== 1
      ? []
      : (await baselineFiles(root)).filter((path) => !expected.has(path)).sort()

  let selected = shots.filter((shot) => !ticketOf(shot))
  if (only) {
    const unknown = only.filter(
      (id) => !stories.some((story) => story.id === id),
    )
    if (unknown.length)
      throw new Error(`Not in the Storybook build: ${unknown.join(", ")}`)
    selected = selected.filter((shot) => only.includes(shot.story.id))
  } else if (subset) {
    selected = selected.filter((shot) => subset.includes(shot.story.id))
  } else if (mode === "update" && failed) {
    const text = await readFile(join(out, "manifest.json"), "utf8").catch(
      () => {
        throw new Error(
          `${join(out, "manifest.json")} is missing. Run pnpm visual:check first: --failed accepts the stories that it failed.`,
        )
      },
    )
    const last = manifestSchema.parse(JSON.parse(text))
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
    const captured = await capture(viewport, [
      ...new Set(group.map((shot) => shot.story)),
    ])
    for (const shot of group)
      results.set(shot, captured.get(shotKey(shot)) ?? { status: "not-run" })
  }

  let failures = 0
  const entries: ManifestStory[] = []
  if (mode === "check") {
    await rm(out, { recursive: true, force: true })
    for (const [shot, result] of results) {
      const entry = await compareShot(root, out, shot, result)
      if (entry.status !== "unchanged") {
        failures++
        print(`${entry.status}: ${shot.baseline}`)
      }
      if (entry.layout?.length) failures++
      printLayout(print, shot, result)
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
      printLayout(print, shot, result)
      if (result.status !== "captured" || !result.png) {
        failures++
        print(
          `${notCaptured(result)}: ${shotKey(shot)} at ${shot.viewport}; no baseline written${result.error ? ` (${result.error})` : ""}`,
        )
        continue
      }
      const path = join(root, shot.baseline)
      const old = await readFile(path).catch(() => null)
      if (
        old &&
        (await diff(old, result.png, { maxDiffPixels: shot.maxDiffPixels }))
          .status === "unchanged"
      )
        continue
      await mkdir(join(path, ".."), { recursive: true })
      // No row filter: the flat colors of the UI compress best without one
      // (about 17% smaller than the adaptive filter, and smaller than
      // oxipng -o max on a sample of 40 baselines).
      await writeFile(
        path,
        encode(decode(result.png), { compression: 12, filter: "none" }),
      )
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

  const over = await overBudget(
    root,
    budget,
    mode === "check" && subset
      ? selected.map((shot) => shot.baseline)
      : undefined,
  )
  // The first shard of a full run also checks the total size.
  if (shard?.at === 1)
    over.push(
      ...(await overBudget(root, budget)).filter((error) => !error.path),
    )
  for (const error of over) print(error.message)
  return {
    code: failures || over.length ? 1 : 0,
    stories: entries,
    budget: over,
  }
}

/** Prints each layout problem of a screenshot, with its baseline. */
const printLayout = (
  print: (line: string) => void,
  shot: Shot,
  result: Captured,
) => {
  for (const problem of result.layout ?? [])
    print(
      `layout: ${shot.baseline}: ${problem.rule}: ${problem.element}: ${problem.detail}`,
    )
}

/** The manifest status of a screenshot that the capture did not give. */
const notCaptured = (result: Captured) =>
  result.status === "unstable" ? "unstable" : "play-failed"

/** The manifest entry of one captured screenshot, with its images in `out`. */
async function compareShot(
  root: string,
  out: string,
  shot: Shot,
  result: Captured,
): Promise<ManifestStory> {
  const dir = shot.snapshot
    ? posix.join(shot.story.id, `@${shot.snapshot}`, shot.viewport)
    : posix.join(shot.story.id, shot.viewport)
  const base: ManifestStory = {
    id: shot.story.id,
    title: shot.story.title,
    componentFile: shot.storyFile,
    scope: shot.scope,
    viewport: shot.viewport,
    snapshot: shot.snapshot,
    baseline: shot.baseline,
    status: "new",
    maxDiffPixels: shot.maxDiffPixels,
    size: null,
    diffPixels: null,
    regions: [],
    severity: null,
    summary: null,
    signature: null,
    omittedRegions: 0,
    images: {},
    ...(result.layout && { layout: result.layout }),
  }
  const writeAfter = async (png: Uint8Array) => {
    await mkdir(join(out, dir), { recursive: true })
    await writeFile(join(out, dir, "after.png"), png)
    return { after: posix.join(dir, "after.png") }
  }
  if (result.status !== "captured" || !result.png)
    return {
      ...base,
      status: notCaptured(result),
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
  const comparison = await diff(old, result.png, {
    maxDiffPixels: shot.maxDiffPixels,
  })
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
  // <stem>.<story name>[@<snapshot>].<viewport>.screenshot.png. A story file
  // name can hold a dot; an export name cannot.
  const [story = "", snapshot = null] = name
    .replace(/\.(?:desktop|mobile)\.screenshot\.png$/, "")
    .split("@")
  const stem = story.includes(".")
    ? story.slice(0, story.lastIndexOf("."))
    : story
  const folder = posix.dirname(baseline)
  return {
    id: baseline,
    title: "",
    componentFile: posix.join(
      posix.basename(folder) === "screenshots" ? posix.dirname(folder) : folder,
      `${stem}.stories.tsx`,
    ),
    scope: "component",
    viewport: name.endsWith(".mobile.screenshot.png") ? "mobile" : "desktop",
    snapshot,
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

/**
 * Each `*.screenshot.png` file under apps/ui, from the repository root. It
 * does not look in `node_modules` or in the Storybook build.
 */
async function baselineFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string) => {
    const entries = await readdir(join(root, dir), {
      withFileTypes: true,
    }).catch(() => [])
    for (const entry of entries) {
      const path = posix.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!["node_modules", "storybook-static"].includes(entry.name))
          await walk(path)
      } else if (entry.isFile() && entry.name.endsWith(".screenshot.png"))
        files.push(path)
    }
  }
  await walk("apps/ui")
  return files
}

/** A size budget error, with the baseline that it names, if one. */
type BudgetError = { path?: string; message: string }

/**
 * The size budget errors of the committed baselines. With `paths`, only the
 * image budget of those baselines.
 */
async function overBudget(
  root: string,
  budget: { total: number; image: number },
  paths?: readonly string[],
): Promise<BudgetError[]> {
  const errors: BudgetError[] = []
  let total = 0
  for (const path of paths ?? (await baselineFiles(root))) {
    const size = await stat(join(root, path)).then(
      (file) => file.size,
      () => 0,
    )
    total += size
    if (size > budget.image)
      errors.push({
        path,
        message: `${path} is ${mb(size)}; one image may be ${mb(budget.image)}. Make the story smaller, or mask the content that does not compress.`,
      })
  }
  if (!paths && total > budget.total)
    errors.push({
      message: `The baselines are ${mb(total)} in total; the budget is ${mb(budget.total)}.`,
    })
  return errors
}

const mb = (count: number) =>
  `${Number((count / (1024 * 1024)).toPrecision(3))} MB`
