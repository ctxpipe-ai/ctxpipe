// Builds the case set of the visual critic bake-off (CTX-1200): real intended
// changes from the git history, synthetic regressions with a known region,
// noise, and mixed cases. It writes the images to the output folder and the
// case manifest to cases.json beside this file. The same seed and the same
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
  copyFileSync,
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
import { runInContainer } from "../../../../scripts/ci/visual-capture.mjs"
import pin from "../../../../scripts/ci/visual-container.json" with { type: "json" }
import unstableList from "../../../../scripts/ci/visual-unstable-stories.json" with { type: "json" }
import { diff } from "../../src/compare/diff.ts"
import type { Job, ShotResult, StoryJob } from "./capture.ts"
import {
  caseManifestJsonSchema,
  caseManifestSchema,
  type Case,
  type CaseManifest,
} from "./cases.ts"
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

type Commit = {
  sha: string
  parent: string
  brief: string
  storyFiles: string[]
}

// The story files that a commit can change: a changed story file, and the
// story file beside a changed component (X.tsx -> X.stories.tsx).
function storyFilesOf(sha: string, parent: string): string[] {
  const changed = git("diff", "--name-only", parent, sha, "--", "apps/ui/src")
    .split("\n")
    .filter(Boolean)
  const tree = new Set(
    git("ls-tree", "-r", "--name-only", sha, "--", "apps/ui/src").split("\n"),
  )
  const files = new Set<string>()
  for (const file of changed) {
    const story = file.endsWith(".stories.tsx")
      ? file
      : file.replace(/\.(tsx|ts|css)$/, ".stories.tsx")
    if (tree.has(story)) files.add(story)
  }
  return [...files].sort()
}

// The commit message without its trailers, and the pull request title when
// the GitHub CLI finds it. The brief is data for the critic.
function briefOf(sha: string): string {
  const message = git("log", "-1", "--format=%B", sha)
    .split("\n")
    .filter((line) => !/^(Co-Authored-By|Signed-off-by):/i.test(line))
    .join("\n")
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

function history(until: string): Commit[] {
  const commits: Commit[] = []
  const shas = git(
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
  for (const line of shas) {
    // The newest 60 commits that change a story.
    if (commits.length === 60) break
    const [sha = "", parent = ""] = line.split(" ")
    const storyFiles = storyFilesOf(sha, parent)
    if (storyFiles.length)
      commits.push({ sha, parent, brief: briefOf(sha), storyFiles })
  }
  return commits
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

/** A pair of screenshots that can become a case. */
type Candidate = {
  kind: Case["kind"]
  mutation: MutationClass | null
  storyId: string
  commit: Commit | null
  before: string
  after: string
  /** For a mixed case: the clean after image, without the regression. */
  clean?: string
}

/** The file name of one screenshot. */
const shot = (key: string, storyId: string, role: string) =>
  `${key}--${storyId}--${role}.png`

/** Case ids: the prefix and a number with `width` digits. */
const numbered = <T>(prefix: string, entries: readonly T[], width: number) =>
  entries.map((entry, i): [string, T] => [
    `${prefix}-${String(i + 1).padStart(width, "0")}`,
    entry,
  ])

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: "string", default: "1" },
      until: {
        type: "string",
        default: "24696e785d9c4d8665eb0e69082098188ffa2e96",
      },
      out: {
        type: "string",
        default: join(root, ".ci-results/visual-bakeoff"),
      },
    },
  })
  const seed = Number(values.seed)
  const until = git("rev-parse", `${values.until}^{commit}`).trim()
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

  // A story that is known to differ between two runs at the desktop
  // viewport gives no case: its pair can differ only because of the flake.
  const unstable = new Set(
    unstableList.stories
      .filter(
        (entry) =>
          ("viewport" in entry ? entry.viewport : "desktop") === "desktop",
      )
      .map((entry) => entry.id),
  )

  // The jobs of each build, and the candidate pairs of screenshots.
  // Two commits can share a build, so a job can come two times.
  const jobs = new Map<string, StoryJob[]>()
  const added = new Set<string>()
  const add = (key: string, job: StoryJob) => {
    const id = JSON.stringify([key, job])
    if (added.has(id)) return
    added.add(id)
    jobs.set(key, [...(jobs.get(key) ?? []), job])
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
    const files = new Set(
      commit.storyFiles.map((file) => `./${file.replace(/^apps\/ui\//, "")}`),
    )
    const stories = storyEntries(out, after)
      .filter((entry) => files.has(entry.importPath) && !unstable.has(entry.id))
      .map((entry) => entry.id)
      .sort()
    // Up to 10 stories of each commit.
    for (const storyId of shuffle(stories, derive(seed, commit.sha)).slice(
      0,
      10,
    )) {
      const mutation =
        mixedClasses[
          Math.abs(derive(seed, commit.sha, storyId)) % mixedClasses.length
        ] ?? "padding"
      const clean = shot(after, storyId, "clean")
      const mixed = shot(after, storyId, `mixed-${mutation}`)
      add(before, { id: storyId, clean: shot(before, storyId, "clean") })
      add(after, {
        id: storyId,
        clean,
        mutated: {
          file: mixed,
          kind: mutation,
          seed: derive(seed, commit.sha, storyId, mutation),
        },
      })
      const common = {
        storyId,
        commit,
        before: shot(before, storyId, "clean"),
      }
      candidates.push(
        { ...common, kind: "intended", mutation: null, after: clean },
        { ...common, kind: "mixed", mutation, after: mixed, clean },
      )
    }
  }

  // Synthetic cases on the newest build. Each class tries 40 other
  // stories, because a class cannot apply to each story.
  const pool = shuffle(
    storyEntries(out, untilKey)
      .map((entry) => entry.id)
      .filter((id) => !unstable.has(id))
      .sort(),
    derive(seed, "synthetic"),
  )
  const tries = 40
  ;[...regressionClasses, ...noiseClasses].forEach((mutation, offset) => {
    for (let i = 0; i < tries; i++) {
      const storyId = pool[(offset * tries + i) % pool.length]
      if (!storyId) continue
      const before = shot(untilKey, storyId, `clean-for-${mutation}`)
      const after = shot(untilKey, storyId, mutation)
      add(untilKey, {
        id: storyId,
        clean: before,
        mutated: {
          file: after,
          kind: mutation,
          seed: derive(seed, storyId, mutation),
        },
      })
      candidates.push({
        kind: isNoise(mutation) ? "noise" : "regression",
        mutation,
        storyId,
        commit: null,
        before,
        after,
      })
    }
  })

  // Capture in 4 containers that run at the same time, each with whole
  // builds.
  const parts: Job[][] = [[], [], [], []]
  const size = (part: Job[]) =>
    part.reduce((sum, job) => sum + job.stories.length, 0)
  for (const [key, stories] of [...jobs].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const smallest = parts.reduce((min, part) =>
      size(part) < size(min) ? part : min,
    )
    smallest.push({ build: relative(root, join(out, "builds", key)), stories })
  }
  rmSync(join(out, "shots"), { recursive: true, force: true })
  mkdirSync(join(out, "jobs"), { recursive: true })
  await Promise.all(
    parts.map(async (part, i) => {
      if (!part.length) return
      const jobFile = join(out, "jobs", `shard-${i}.json`)
      writeFileSync(jobFile, JSON.stringify(part))
      await runInContainer(
        "packages/visual-review/evals/critic/capture.ts",
        [relative(root, jobFile)],
        join(out, "shots", `shard-${i}`),
      )
    }),
  )
  const results = new Map<string, ShotResult & { path: string }>()
  parts.forEach((_, i) => {
    const file = join(out, "shots", `shard-${i}`, "results.json")
    if (!existsSync(file)) return
    for (const result of (
      JSON.parse(readFileSync(file, "utf8")) as { shots: ShotResult[] }
    ).shots)
      results.set(result.file, {
        ...result,
        path: join(out, "shots", `shard-${i}`, result.file),
      })
  })

  // Keep the pairs that differ beyond the tolerance of the visual check.
  const captured = (file: string | undefined) => {
    const result = file ? results.get(file) : undefined
    return result?.status === "captured" ? result : undefined
  }
  // The diff pixels of a pair, or null when the pair does not differ (or
  // the size changed: a viewport screenshot keeps its size).
  const differs = async (a: string, b: string) => {
    const comparison = await diff(readFileSync(a), readFileSync(b))
    return comparison.status === "changed" ? comparison.diffPixels : null
  }
  type Kept = Candidate & {
    diffPixels: number
    region: ShotResult["region"]
    beforePath: string
    afterPath: string
  }
  const kept: Kept[] = []
  for (const candidate of candidates) {
    const before = captured(candidate.before)
    const after = captured(candidate.after)
    if (!before || !after) continue
    // A mixed case needs both parts: the real change (the before and the
    // clean after image differ) and the regression (the clean after and the
    // after image differ).
    if (candidate.clean) {
      const clean = captured(candidate.clean)
      if (
        !clean ||
        (await differs(before.path, clean.path)) === null ||
        (await differs(clean.path, after.path)) === null
      )
        continue
    }
    const region = after.region ?? null
    if (
      (candidate.kind === "regression" || candidate.kind === "mixed") &&
      !region
    )
      continue
    const diffPixels = await differs(before.path, after.path)
    if (diffPixels !== null)
      kept.push({
        ...candidate,
        diffPixels,
        region,
        beforePath: before.path,
        afterPath: after.path,
      })
  }

  // Select the cases: 60 intended cases, 10 of each synthetic class, and 20
  // mixed cases. A mixed case can use the pair of an intended case: then the
  // two cases differ only by the hidden regression.
  const pick = (kind: Case["kind"], mutation: MutationClass | null) =>
    kept.filter((entry) => entry.kind === kind && entry.mutation === mutation)
  const mixed = shuffle(
    kept.filter((entry) => entry.kind === "mixed"),
    derive(seed, "mixed"),
  ).slice(0, 20)
  const selected = [
    ...numbered("intended", pick("intended", null).slice(0, 60), 3),
    ...regressionClasses.flatMap((mutation) =>
      numbered(
        `regression-${mutation}`,
        pick("regression", mutation).slice(0, 10),
        2,
      ),
    ),
    ...noiseClasses.flatMap((mutation) =>
      numbered(`noise-${mutation}`, pick("noise", mutation).slice(0, 10), 2),
    ),
    ...numbered("mixed", mixed, 2),
  ]
  // A run with too few cases (for example, after failed builds) must not
  // replace the committed manifest.
  if (selected.length < 150)
    throw new Error(
      `Only ${selected.length} cases, fewer than 150. The manifest did not change.`,
    )

  rmSync(join(out, "cases"), { recursive: true, force: true })
  const cases = selected.map(([id, entry]) => {
    mkdirSync(join(out, "cases", id), { recursive: true })
    copyFileSync(entry.beforePath, join(out, "cases", id, "before.png"))
    copyFileSync(entry.afterPath, join(out, "cases", id, "after.png"))
    return {
      id,
      storyId: entry.storyId,
      viewport: { name: "desktop", width: 1440, height: 900 },
      diffPixels: entry.diffPixels,
      images: {
        before: `cases/${id}/before.png`,
        after: `cases/${id}/after.png`,
      },
      kind: entry.kind,
      label: entry.kind === "mixed" ? "regression" : entry.kind,
      class: entry.mutation,
      brief: entry.commit?.brief ?? null,
      commit: entry.commit
        ? { sha: entry.commit.sha, parent: entry.commit.parent }
        : null,
      region: entry.region ?? null,
    }
  })
  const manifest: CaseManifest = caseManifestSchema.parse({
    $schema: "./cases.schema.json",
    version: 1,
    seed,
    until,
    container: `${pin.image}:${pin.tag}@${pin.digest}`,
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
  const counts = (["intended", "regression", "noise", "mixed"] as const).map(
    (kind) =>
      `${manifest.cases.filter((entry) => entry.kind === kind).length} ${kind}`,
  )
  process.stdout.write(
    `${cases.length} cases (${counts.join(", ")}) in ${Math.round((performance.now() - started) / 1000)} s. Images: ${relative(root, join(out, "cases"))}\n`,
  )
}

if (import.meta.main) await main()
