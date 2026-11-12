// Builds the case set of the visual critic bake-off (CTX-1200): real intended
// changes from the git history, synthetic regressions with a known region,
// noise, and mixed cases. It writes the images to <out>/images, each as
// <sha256>.png, and the case manifest to cases.json beside this file. The same seed and the same
// `--until` commit give the same cases.
//
// Usage: pnpm visual:bakeoff:build [--seed <n>] [--until <commit>] [--out <dir>]
//
// It needs Docker (the pinned capture container) and about 1 GB of disk for
// each Storybook build. A build is kept in <out>/builds, so a second run
// builds nothing again.

import { execFileSync, execSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"

import type { IndexStory } from "../../../../scripts/ci/storybook-play.mjs"
import {
  runInContainer,
  viewports,
} from "../../../../scripts/ci/visual-capture.mjs"
import pin from "../../../../scripts/ci/visual-container.json" with { type: "json" }
import unstableList from "../../../../scripts/ci/visual-unstable-stories.json" with { type: "json" }
import { diff, type Comparison } from "../../src/compare/diff.ts"
import type { Job, ShotResult, StoryJob } from "./capture.ts"
import {
  caseManifestJsonSchema,
  caseManifestSchema,
  type Case,
  type CaseManifest,
} from "./cases.ts"
import { imageFile, sha256Of } from "./images.ts"
import {
  isNoise,
  noiseClasses,
  regressionClasses,
  seeded,
  type MutationClass,
} from "./mutations.ts"

const root = resolve(import.meta.dirname, "../../../..")
const here = import.meta.dirname

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })

/** A whole number from the seed and some names, for one seeded choice. */
function derive(seed: number, ...names: string[]): number {
  return createHash("sha256")
    .update([seed, ...names].join("\0"))
    .digest()
    .readInt32LE(0)
}

/** A copy of `items` in a seeded order. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const random = seeded(seed)
  return items
    .map((item) => ({ item, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item)
}

type Commit = { sha: string; parent: string; brief: string }

// The commit message without its trailers, and the pull request title when
// the GitHub CLI finds it. The brief is data for the critic.
function briefOf(sha: string): string {
  const message = git("log", "-1", "--format=%B", sha)
    .split("\n")
    .filter((line) => !/^(Co-Authored-By|Signed-off-by):/i.test(line))
    .join("\n")
    // The required story set had an older name that the team no longer
    // uses (CTX-1178, Phase 0). A brief uses the new name.
    .replace(/\bg[o]lden\b/gi, "required")
    .trim()
  const number = /\(#(\d+)\)$/m.exec(message.split("\n")[0] ?? "")?.[1]
  if (!number) return message
  try {
    const title = execFileSync(
      "gh",
      ["pr", "view", number, "--json", "title", "--jq", ".title"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim()
    return title && !message.startsWith(title)
      ? `Pull request: ${title}\n\n${message}`
      : message
  } catch {
    return message
  }
}

/**
 * The newest 40 first-parent commits that change apps/ui/src. A page renders
 * many components, so a commit can change a page that does not import the
 * changed file directly: the builder renders each page story of each commit,
 * and the pixel diff finds the pages that changed.
 */
function history(until: string): Commit[] {
  return git(
    "log",
    "--first-parent",
    "--no-merges",
    "--format=%H %P",
    until,
    "--",
    "apps/ui/src",
  )
    .split("\n")
    .filter(Boolean)
    .slice(0, 40)
    .map((line) => {
      const [sha = "", parent = ""] = line.split(" ")
      return { sha, parent, brief: briefOf(sha) }
    })
}

/**
 * True when a real change is clearly visible (CTX-1249): the changed pixels
 * of the regions that the BlazeDiff interpreter does not call
 * `rendering-noise` cover at least 0.2% of the image (2,592 pixels at the
 * desktop viewport, 659 at the mobile one). A smaller change (a status dot, a
 * small icon, anti-aliasing) does not show on a full page screenshot, so a
 * judge cannot label it.
 */
export function visible(comparison: Comparison): boolean {
  if (comparison.status !== "changed") return false
  const visiblePixels = comparison.regions
    .filter(({ changeType }) => changeType !== "rendering-noise")
    .reduce((sum, { pixels }) => sum + pixels, 0)
  return visiblePixels >= 0.002 * comparison.size.width * comparison.size.height
}

/** The key of a Storybook build: the trees that the build reads. */
function buildKey(sha: string): string {
  const trees = ["apps/ui", "packages", "pnpm-lock.yaml"].map((path) =>
    git("rev-parse", `${sha}:${path}`).trim(),
  )
  return createHash("sha256").update(trees.join(" ")).digest("hex").slice(0, 16)
}

const run = (command: string, args: string[], cwd: string) =>
  new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let log = ""
    child.stdout.on("data", (chunk) => (log += chunk))
    child.stderr.on("data", (chunk) => (log += chunk))
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0
        ? resolveRun()
        : reject(
            new Error(
              `${command} ${args.join(" ")} failed:\n${log.slice(-4000)}`,
            ),
          ),
    )
  })

// Builds the Storybook of a commit into <out>/builds/<key>, from a clean
// export of the commit in a temporary folder. Returns false when it fails.
async function buildStorybook(sha: string, key: string, out: string) {
  const build = join(out, "builds", key)
  if (existsSync(join(build, "index.json"))) return true
  const source = mkdtempSync(join(tmpdir(), "ctxpipe-bakeoff-"))
  try {
    execSync(`git archive ${sha} | tar -x -C ${JSON.stringify(source)}`, {
      cwd: root,
      maxBuffer: 1 << 30,
    })
    // A full install: an install of the UI and its dependencies only does
    // not build (the Storybook config reads more of the workspace).
    await run(
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline"],
      source,
    )
    await run("pnpm", ["--filter", "@ctxpipe/ui", "build-storybook"], source)
    cpSync(join(source, "apps/ui/storybook-static"), build, { recursive: true })
    return true
  } catch (error) {
    process.stderr.write(`No Storybook build for ${sha}: ${String(error)}\n`)
    return false
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
}

async function inParallel<T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>,
) {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift())
        await work(item)
    }),
  )
}

const storyEntries = (out: string, key: string): IndexStory[] =>
  Object.values(
    (
      JSON.parse(
        readFileSync(join(out, "builds", key, "index.json"), "utf8"),
      ) as {
        entries: Record<string, IndexStory>
      }
    ).entries,
  ).filter((entry) => entry.type === "story")

type Viewport = Job["viewport"]
const viewportNames: readonly Viewport[] = ["desktop", "mobile"]

/** A pair of screenshots that can become a case. */
type Candidate = {
  kind: Case["kind"]
  mutation: MutationClass | null
  storyId: string
  viewport: Viewport
  commit: Commit | null
  /** Absent for a new case: the story is not in the first parent. */
  before?: string
  after: string
  /** For a mixed case: the clean after image, without the regression. */
  clean?: string
}

/** The file name of one screenshot. */
const shot = (key: string, viewport: Viewport, storyId: string, role: string) =>
  `${key}--${viewport}--${storyId}--${role}.png`

/**
 * Case ids: the prefix and a hash of the commit, the story, the viewport and
 * the class. A case keeps its id when another case drops out of a run, so a
 * label stays on its case.
 */
const identified = <T extends Candidate>(
  prefix: string,
  entries: readonly T[],
) =>
  entries.map((entry): [string, T] => [
    `${prefix}-${createHash("sha256")
      .update(
        [entry.commit?.sha, entry.storyId, entry.viewport, entry.mutation].join(
          " ",
        ),
      )
      .digest("hex")
      .slice(0, 8)}`,
    entry,
  ])

type Shots = Map<string, ShotResult & { path: string }>

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: "string", default: "1" },
      until: {
        type: "string",
        default: "cf5636d04fac97bd60be8bc46698c9ad8c278249",
      },
      out: {
        type: "string",
        default: join(root, ".ci-results/visual-bakeoff"),
      },
    },
  })
  const seed = Number(values.seed)
  const until = git("rev-parse", `${values.until}^{commit}`).trim()
  // The builder installs and builds each commit on this host, so it reads
  // only the reviewed history of main.
  try {
    git("merge-base", "--is-ancestor", until, "origin/main")
  } catch {
    throw new Error(`${until} is not in the history of origin/main.`)
  }
  const out = resolve(values.out)
  if (relative(root, out).startsWith(".."))
    throw new Error(
      "The output folder must be in the repository: the capture container mounts only the repository.",
    )
  const started = performance.now()

  const commits = history(until)
  const untilKey = buildKey(until)
  // The build key of each commit to render. Commits with the same trees
  // share one build.
  const keys = new Map<string, string>([[until, untilKey]])
  for (const commit of commits)
    for (const sha of [commit.sha, commit.parent]) keys.set(sha, buildKey(sha))
  const shaOf = new Map<string, string>()
  for (const [sha, key] of keys) if (!shaOf.has(key)) shaOf.set(key, sha)
  process.stdout.write(
    `${commits.length} commits, ${shaOf.size} Storybook builds.\n`,
  )
  const built = new Set<string>()
  await inParallel([...shaOf], 3, async ([key, sha]) => {
    if (await buildStorybook(sha, key, out)) built.add(key)
    process.stdout.write(
      `build ${key} (${sha.slice(0, 9)}): ${built.has(key) ? "ok" : "failed"}\n`,
    )
  })
  if (!built.has(untilKey))
    throw new Error(`The Storybook of ${until} did not build.`)

  // The page stories: the stories with the `page` tag in the newest build.
  // An older build can have no tags, but its story ids are the same.
  const pages = new Set(
    storyEntries(out, untilKey)
      .filter((entry) => (entry.tags ?? []).includes("page"))
      .map((entry) => entry.id),
  )
  // A screenshot that is known to differ between two runs gives no case: its
  // pair can differ only because of the flake. The type of the entries is
  // written here: when no story is unstable, the JSON import gives the type
  // never[].
  const unstableStories: { id: string; viewport?: Viewport }[] =
    unstableList.stories
  const steady = (id: string, viewport: Viewport) =>
    !unstableStories.some(
      (entry) => entry.id === id && (entry.viewport ?? viewport) === viewport,
    )

  // The jobs of each build and viewport, and the candidate pairs of
  // screenshots. Two commits can share a build, so a job can come two times.
  const jobs = new Map<string, Job>()
  const added = new Set<string>()
  const add = (key: string, viewport: Viewport, story: StoryJob) => {
    const id = JSON.stringify([key, viewport, story])
    if (added.has(id)) return
    added.add(id)
    const job = jobs.get(`${key} ${viewport}`) ?? {
      build: relative(root, join(out, "builds", key)),
      viewport,
      stories: [],
    }
    job.stories.push(story)
    jobs.set(`${key} ${viewport}`, job)
  }
  const candidates: Candidate[] = []
  // A focus ring needs a focus before the clean shot, so it cannot hide in
  // the clean after image of a real change.
  const mixedClasses = regressionClasses.filter(
    (mutation) => mutation !== "focus-ring",
  )

  for (const commit of commits) {
    const after = keys.get(commit.sha)
    const before = keys.get(commit.parent)
    if (!after || !before || !built.has(after) || !built.has(before)) continue
    const stories = storyEntries(out, after)
      .map((entry) => entry.id)
      .filter((id) => pages.has(id))
      .sort()
    // A story that the first parent does not have is new: it has no before
    // image, so it gives new cases.
    const old = new Set(storyEntries(out, before).map((entry) => entry.id))
    for (const storyId of stories)
      for (const viewport of viewportNames) {
        if (!steady(storyId, viewport)) continue
        const mutation =
          mixedClasses[
            Math.abs(derive(seed, commit.sha, storyId, viewport)) %
              mixedClasses.length
          ] ?? "padding"
        const clean = shot(after, viewport, storyId, "clean")
        const mixed = shot(after, viewport, storyId, `mixed-${mutation}`)
        const isNew = !old.has(storyId)
        if (!isNew)
          add(before, viewport, {
            id: storyId,
            clean: shot(before, viewport, storyId, "clean"),
          })
        add(after, viewport, {
          id: storyId,
          clean,
          mutated: {
            file: mixed,
            mutation,
            seed: derive(seed, commit.sha, storyId, viewport, mutation),
          },
        })
        const common = { storyId, viewport, commit }
        if (isNew) {
          candidates.push(
            { ...common, kind: "new", mutation: null, after: clean },
            { ...common, kind: "new", mutation, after: mixed, clean },
          )
          continue
        }
        const pair = {
          ...common,
          before: shot(before, viewport, storyId, "clean"),
        }
        candidates.push(
          { ...pair, kind: "intended", mutation: null, after: clean },
          { ...pair, kind: "mixed", mutation, after: mixed, clean },
        )
      }
  }

  // Synthetic cases on the newest build. Each class tries 40 other page
  // screenshots, because a class cannot apply to each story.
  const pool = shuffle(
    [...pages]
      .sort()
      .flatMap((id) =>
        viewportNames
          .filter((viewport) => steady(id, viewport))
          .map((viewport) => ({ id, viewport })),
      ),
    derive(seed, "synthetic"),
  )
  const tries = 40
  ;[...regressionClasses, ...noiseClasses].forEach((mutation, offset) => {
    for (let i = 0; i < tries; i++) {
      const target = pool[(offset * tries + i) % pool.length]
      if (!target) continue
      const { id: storyId, viewport } = target
      const before = shot(untilKey, viewport, storyId, `clean-for-${mutation}`)
      const after = shot(untilKey, viewport, storyId, mutation)
      add(untilKey, viewport, {
        id: storyId,
        clean: before,
        mutated: {
          file: after,
          mutation,
          seed: derive(seed, storyId, viewport, mutation),
        },
      })
      candidates.push({
        kind: isNoise(mutation) ? "noise" : "regression",
        mutation,
        storyId,
        viewport,
        commit: null,
        before,
        after,
      })
    }
  })

  // Capture the jobs in parts of at most 800 stories, 8 containers at the
  // same time. A container has one hour (runInContainer), and a page story
  // takes about 2 seconds with its mutated screenshot.
  rmSync(join(out, "shots"), { recursive: true, force: true })
  mkdirSync(join(out, "jobs"), { recursive: true })
  const capture = async (round: number, all: readonly Job[]) => {
    const parts: Job[][] = [[]]
    let size = 0
    for (const job of all)
      for (let start = 0; start < job.stories.length; start += 100) {
        const stories = job.stories.slice(start, start + 100)
        if (size + stories.length > 800) {
          parts.push([])
          size = 0
        }
        parts.at(-1)?.push({ ...job, stories })
        size += stories.length
      }
    await inParallel(
      parts.map((part, i) => ({ part, i })),
      8,
      async ({ part, i }) => {
        if (!part.length) return
        const jobFile = join(out, "jobs", `round-${round}-part-${i}.json`)
        writeFileSync(jobFile, JSON.stringify(part))
        await runInContainer(
          "packages/visual-review/evals/critic/capture.ts",
          [relative(root, jobFile)],
          join(out, "shots", `round-${round}`, `part-${i}`),
        )
      },
    )
    const shots: Shots = new Map()
    parts.forEach((_, i) => {
      const folder = join(out, "shots", `round-${round}`, `part-${i}`)
      const file = join(folder, "results.json")
      if (!existsSync(file)) return
      for (const result of (
        JSON.parse(readFileSync(file, "utf8")) as { shots: ShotResult[] }
      ).shots)
        if (result.status === "captured")
          shots.set(result.file, { ...result, path: join(folder, result.file) })
    })
    return shots
  }

  // The facts of a pair of screenshots that differ beyond the tolerance of
  // the visual check, or null. A viewport screenshot keeps its size, so a
  // size change is not a pair. Most pages do not change in a commit, so
  // equal bytes skip the diff. Each pair is compared once, and only its
  // facts stay in memory, not its diff image.
  type Facts = { diffPixels: number; signature: string; visible: boolean }
  const compared = new Map<string, Promise<Facts | null>>()
  const compare = (a: string, b: string) => {
    let facts = compared.get(`${a} ${b}`)
    if (!facts) {
      const [x, y] = [readFileSync(a), readFileSync(b)]
      facts = x.equals(y)
        ? Promise.resolve(null)
        : diff(x, y).then((comparison) =>
            comparison.status === "changed"
              ? {
                  diffPixels: comparison.diffPixels,
                  signature: comparison.signature,
                  visible: visible(comparison),
                }
              : null,
          )
      compared.set(`${a} ${b}`, facts)
    }
    return facts
  }
  const differs = async (a: string, b: string) => (await compare(a, b)) !== null
  type Kept = Candidate & {
    /** Null for a new case: there is no before image. */
    diffPixels: number | null
    region: ShotResult["region"]
    /** The region signature of a real change, for one case of each. */
    signature: string | null
    beforePath: string | null
    afterPath: string
  }
  // The candidates whose screenshots `shots` has and that make a case.
  const evaluate = async (shots: Shots) => {
    const kept: Kept[] = []
    const captured = (file: string | undefined) =>
      file ? shots.get(file) : undefined
    for (const candidate of candidates) {
      const after = captured(candidate.after)
      if (!after) continue
      if (candidate.kind === "new") {
        // A broken new case needs a regression that shows: its after image
        // differs from the clean render, and it has a known region.
        const clean = captured(candidate.clean)
        if (
          candidate.clean &&
          (!clean || !after.region || !(await differs(clean.path, after.path)))
        )
          continue
        kept.push({
          ...candidate,
          diffPixels: null,
          region: candidate.clean ? after.region : null,
          signature: null,
          beforePath: null,
          afterPath: after.path,
        })
        continue
      }
      const before = captured(candidate.before)
      if (!before) continue
      // A real change must be clearly visible. A mixed case needs both
      // parts: the visible real change (the before and the clean after
      // image) and the regression (the clean after and the after image).
      let signature: string | null = null
      if (candidate.kind === "intended" || candidate.kind === "mixed") {
        const clean = captured(candidate.clean ?? candidate.after)
        if (!clean) continue
        const real = await compare(before.path, clean.path)
        if (!real?.visible) continue
        signature = real.signature
        if (candidate.clean && !(await differs(clean.path, after.path)))
          continue
      }
      const region = after.region ?? null
      if (
        (candidate.kind === "regression" || candidate.kind === "mixed") &&
        !region
      )
        continue
      const comparison = await compare(before.path, after.path)
      if (comparison)
        kept.push({
          ...candidate,
          diffPixels: comparison.diffPixels,
          region,
          signature,
          beforePath: before.path,
          afterPath: after.path,
        })
    }
    return kept
  }

  // Round 1 captures all jobs. Round 2 captures again only the stories of
  // the candidates that round 1 keeps: a screenshot that is not the same in
  // the two rounds (a story that is not steady) gives no case, so that the
  // same seed gives the same images.
  const first = await capture(1, [...jobs.values()])
  const firstKept = await evaluate(first)
  const files = new Set(
    firstKept.flatMap((entry) =>
      [entry.before, entry.after, entry.clean].filter(
        (file): file is string => file !== undefined,
      ),
    ),
  )
  const again = [...jobs.values()].flatMap((job) => {
    const stories = job.stories.filter(
      (story) =>
        files.has(story.clean) ||
        (story.mutated !== undefined && files.has(story.mutated.file)),
    )
    return stories.length ? [{ ...job, stories }] : []
  })
  const second = await capture(2, again)
  const both: Shots = new Map(
    [...first].filter(([file, result]) => {
      const repeat = second.get(file)
      return (
        repeat !== undefined &&
        readFileSync(result.path).equals(readFileSync(repeat.path))
      )
    }),
  )
  const kept = await evaluate(both)

  // Select the cases. Real changes: one case for each commit, viewport and
  // region signature (a change to a shared part, such as the sidebar, shows
  // the same diff on many pages), and at most 6 cases of each commit, so
  // that one large commit does not fill the set. A mixed case can use the
  // pair of a real change: then the two cases differ only by the regression.
  const pick = (kind: Case["kind"], mutation: MutationClass | null) =>
    kept.filter((entry) => entry.kind === kind && entry.mutation === mutation)
  // Each candidate has its own seeded rank. So a candidate that one run
  // loses (a story that is not steady) changes only its own place.
  const rank = (entry: Kept) =>
    derive(
      seed,
      "mixed",
      entry.commit?.sha ?? "",
      entry.storyId,
      entry.viewport,
    )
  const ranked = (entries: readonly Kept[]) =>
    [...entries].sort((a, b) => rank(a) - rank(b))
  const seen = new Set<string>()
  const perCommit = new Map<string, number>()
  const real = ranked(pick("intended", null)).filter((entry) => {
    const sha = entry.commit?.sha ?? ""
    const key = `${sha} ${entry.viewport} ${entry.signature}`
    if (seen.has(key) || (perCommit.get(sha) ?? 0) >= 6) return false
    seen.add(key)
    perCommit.set(sha, (perCommit.get(sha) ?? 0) + 1)
    return true
  })
  // Two stories, or two commits, can give the same pair of images (a page
  // in the same state, or a focus ring that one build shows and the next
  // does not). Each kind keeps one case of each pair.
  const pairs = new Set<string>()
  const once = ([, entry]: [string, Kept]) => {
    const key = [
      entry.kind,
      ...[entry.beforePath, entry.afterPath].map((path) =>
        path ? sha256Of(readFileSync(path)) : "",
      ),
    ].join(" ")
    if (pairs.has(key)) return false
    pairs.add(key)
    return true
  }
  const selected = [
    ...identified("intended", real.slice(0, 60)),
    ...regressionClasses.flatMap((mutation) =>
      identified(
        `regression-${mutation}`,
        pick("regression", mutation).slice(0, 10),
      ),
    ),
    ...noiseClasses.flatMap((mutation) =>
      identified(`noise-${mutation}`, pick("noise", mutation).slice(0, 10)),
    ),
    ...identified(
      "mixed",
      ranked(kept.filter((entry) => entry.kind === "mixed")).slice(0, 20),
    ),
    // Up to 10 new page screenshots as they render, and up to 10 with a
    // regression.
    ...identified("new", ranked(pick("new", null)).slice(0, 10)),
    ...identified(
      "new-broken",
      ranked(
        kept.filter((entry) => entry.kind === "new" && entry.mutation),
      ).slice(0, 10),
    ),
  ].filter(once)
  // A run with too few cases (for example, after failed builds) must not
  // replace the committed manifest.
  if (selected.length < 100)
    throw new Error(
      `Only ${selected.length} cases, fewer than 100. The manifest did not change.`,
    )

  // Each image goes to the image folder by its SHA-256, which is also its
  // name in the release (pnpm visual:bakeoff:publish).
  mkdirSync(join(out, "images"), { recursive: true })
  const stored = (path: string) => {
    const bytes = readFileSync(path)
    const sha256 = sha256Of(bytes)
    writeFileSync(join(out, "images", imageFile(sha256)), bytes)
    return sha256
  }
  const cases = selected.map(([id, entry]) => ({
    id,
    storyId: entry.storyId,
    viewport: { name: entry.viewport, ...viewports[entry.viewport] },
    diffPixels: entry.diffPixels,
    images: {
      ...(entry.beforePath ? { before: stored(entry.beforePath) } : {}),
      after: stored(entry.afterPath),
    },
    kind: entry.kind,
    // A real change has no label until the judge panel gives one.
    label:
      entry.kind === "mixed" || (entry.kind === "new" && entry.mutation)
        ? "regression"
        : entry.kind === "new"
          ? "intended"
          : entry.kind === "intended"
            ? "unsure"
            : entry.kind,
    class: entry.mutation,
    brief: entry.commit?.brief ?? null,
    commit: entry.commit
      ? { sha: entry.commit.sha, parent: entry.commit.parent }
      : null,
    region: entry.region ?? null,
  }))
  const manifest: CaseManifest = caseManifestSchema.parse({
    $schema: "./cases.schema.json",
    version: 1,
    seed,
    until,
    container: `${pin.image}:${pin.tag}@${pin.digest}`,
    scope: "page",
    cases,
  })
  writeFileSync(
    join(here, "cases.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  writeFileSync(
    join(here, "cases.schema.json"),
    `${JSON.stringify(caseManifestJsonSchema, null, 2)}\n`,
  )
  const counts = (
    ["intended", "regression", "noise", "mixed", "new"] as const
  ).map((kind) => {
    const ofKind = manifest.cases.filter((entry) => entry.kind === kind)
    const mobile = ofKind.filter((entry) => entry.viewport.name === "mobile")
    return `${ofKind.length} ${kind} (${mobile.length} mobile)`
  })
  process.stdout.write(
    `${cases.length} cases (${counts.join(", ")}) in ${Math.round((performance.now() - started) / 1000)} s. Images: ${relative(root, join(out, "images"))}\n`,
  )
}

if (import.meta.main) await main()
