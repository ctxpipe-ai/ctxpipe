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
  noiseClasses,
  regressionClasses,
  seeded,
  type MutationClass,
} from "./mutations.ts"

const root = resolve(import.meta.dirname, "../../../..")
const here = import.meta.dirname

// The size of each part of the case set (the plan of CTX-1178, Phase 4).
const target = { intended: 60, regression: 10, noise: 10, mixed: 20 }
// Commits of the history to read, newest first, and stories of each commit.
const commitCount = 45
const storiesPerCommit = 3
// Stories to try for each synthetic class: a class cannot apply to each story.
const triesPerClass = 18
const viewport = { name: "desktop", width: 1440, height: 900 } as const

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
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
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
    if (commits.length === commitCount) break
    const [sha, parent] = line.split(" ") as [string, string]
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
  class: MutationClass | null
  storyId: string
  commit: Commit | null
  before: string
  after: string
  /** For a mixed case: the clean after image, without the regression. */
  clean?: string
  regionOf?: string
}

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
      shards: { type: "string", default: "4" },
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
  process.stdout.write(
    `${commits.length} commits, ${new Set(keys.values()).size} Storybook builds.\n`,
  )
  const built = new Set<string>()
  await inParallel([...new Set(keys.values())], 3, async (key) => {
    const sha = [...keys].find(([, value]) => value === key)![0]
    if (await buildStorybook(sha, key, out)) built.add(key)
    process.stdout.write(
      `build ${key} (${sha.slice(0, 9)}): ${built.has(key) ? "ok" : "failed"}\n`,
    )
  })
  if (!built.has(untilKey))
    throw new Error(`The Storybook of ${until} did not build.`)

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
  const shot = (key: string, storyId: string, role: string) =>
    `${key}--${storyId}--${role}.png`
  const mixedClasses = regressionClasses.filter((kind) => kind !== "focus-ring")

  for (const commit of commits) {
    const after = keys.get(commit.sha)!
    const before = keys.get(commit.parent)!
    if (!built.has(after) || !built.has(before) || after === before) continue
    const files = new Set(
      commit.storyFiles.map((file) => `./${file.replace(/^apps\/ui\//, "")}`),
    )
    const stories = storyEntries(out, after)
      .filter((entry) => files.has(entry.importPath))
      .map((entry) => entry.id)
      .sort()
    for (const storyId of shuffle(stories, derive(seed, commit.sha)).slice(
      0,
      storiesPerCommit,
    )) {
      const kind =
        mixedClasses[
          Math.abs(derive(seed, commit.sha, storyId)) % mixedClasses.length
        ]!
      add(before, { id: storyId, clean: shot(before, storyId, "clean") })
      add(after, {
        id: storyId,
        clean: shot(after, storyId, "clean"),
        mutated: {
          file: shot(after, storyId, `mixed-${kind}`),
          kind,
          seed: derive(seed, commit.sha, storyId, kind),
        },
      })
      candidates.push({
        kind: "intended",
        class: null,
        storyId,
        commit,
        before: shot(before, storyId, "clean"),
        after: shot(after, storyId, "clean"),
      })
      candidates.push({
        kind: "mixed",
        class: kind,
        storyId,
        commit,
        before: shot(before, storyId, "clean"),
        after: shot(after, storyId, `mixed-${kind}`),
        clean: shot(after, storyId, "clean"),
        regionOf: shot(after, storyId, `mixed-${kind}`),
      })
    }
  }

  // Synthetic cases on the newest build. Each class tries other stories.
  const unstable = new Set(unstableList.stories.map((entry) => entry.id))
  const pool = shuffle(
    storyEntries(out, untilKey)
      .map((entry) => entry.id)
      .filter((id) => !unstable.has(id))
      .sort(),
    derive(seed, "synthetic"),
  )
  const classes: MutationClass[] = [...regressionClasses, ...noiseClasses]
  classes.forEach((kind, offset) => {
    for (let i = 0; i < triesPerClass; i++) {
      const storyId = pool[(offset * triesPerClass + i) % pool.length]!
      const before = `${untilKey}--${storyId}--clean-for-${kind}.png`
      const after = `${untilKey}--${storyId}--${kind}.png`
      add(untilKey, {
        id: storyId,
        clean: before,
        mutated: { file: after, kind, seed: derive(seed, storyId, kind) },
      })
      candidates.push({
        kind: (noiseClasses as readonly string[]).includes(kind)
          ? "noise"
          : "regression",
        class: kind,
        storyId,
        commit: null,
        before,
        after,
        regionOf: after,
      })
    }
  })

  // Capture in containers that run at the same time, each with whole builds.
  const shards = Number(values.shards)
  const parts: Job[][] = Array.from({ length: shards }, () => [])
  ;[...jobs]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([key, stories]) => {
      const smallest = parts.reduce((min, part) =>
        part.reduce((n, job) => n + job.stories.length, 0) <
        min.reduce((n, job) => n + job.stories.length, 0)
          ? part
          : min,
      )
      smallest.push({
        build: relative(root, join(out, "builds", key)),
        stories,
      })
    })
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
  type Kept = Candidate & { diffPixels: number; region: ShotResult["region"] }
  const kept: Kept[] = []
  for (const candidate of candidates) {
    const before = captured(candidate.before)
    const after = captured(candidate.after)
    if (!before || !after) continue
    if (candidate.clean) {
      const clean = captured(candidate.clean)
      if (!clean || (await differs(clean.path, after.path)) === null) continue
    }
    const region = candidate.regionOf
      ? (results.get(candidate.regionOf)?.region ?? null)
      : null
    if (
      (candidate.kind === "regression" || candidate.kind === "mixed") &&
      !region
    )
      continue
    const diffPixels = await differs(before.path, after.path)
    if (diffPixels !== null) kept.push({ ...candidate, diffPixels, region })
  }

  // Select the cases: mixed cases first, then intended cases of other pairs.
  const pick = (kind: Case["kind"], kindClass: MutationClass | null) =>
    kept.filter((entry) => entry.kind === kind && entry.class === kindClass)
  const mixed = shuffle(
    kept.filter((entry) => entry.kind === "mixed"),
    derive(seed, "mixed"),
  ).slice(0, target.mixed)
  const mixedPairs = new Set(
    mixed.map((entry) => `${entry.commit!.sha} ${entry.storyId}`),
  )
  const intended = kept
    .filter(
      (entry) =>
        entry.kind === "intended" &&
        !mixedPairs.has(`${entry.commit!.sha} ${entry.storyId}`),
    )
    .slice(0, target.intended)
  const selected: [string, Kept][] = [
    ...intended.map(
      (entry, i) =>
        [`intended-${String(i + 1).padStart(3, "0")}`, entry] as [string, Kept],
    ),
    ...regressionClasses.flatMap((kind) =>
      pick("regression", kind)
        .slice(0, target.regression)
        .map(
          (entry, i) =>
            [`regression-${kind}-${String(i + 1).padStart(2, "0")}`, entry] as [
              string,
              Kept,
            ],
        ),
    ),
    ...noiseClasses.flatMap((kind) =>
      pick("noise", kind)
        .slice(0, target.noise)
        .map(
          (entry, i) =>
            [`noise-${kind}-${String(i + 1).padStart(2, "0")}`, entry] as [
              string,
              Kept,
            ],
        ),
    ),
    ...mixed.map(
      (entry, i) =>
        [`mixed-${String(i + 1).padStart(2, "0")}`, entry] as [string, Kept],
    ),
  ]

  rmSync(join(out, "cases"), { recursive: true, force: true })
  const cases = selected.map(([id, entry]) => {
    mkdirSync(join(out, "cases", id), { recursive: true })
    copyFileSync(
      results.get(entry.before)!.path,
      join(out, "cases", id, "before.png"),
    )
    copyFileSync(
      results.get(entry.after)!.path,
      join(out, "cases", id, "after.png"),
    )
    const common = {
      id,
      storyId: entry.storyId,
      viewport,
      diffPixels: entry.diffPixels,
      images: {
        before: `cases/${id}/before.png`,
        after: `cases/${id}/after.png`,
      },
    }
    const commit = entry.commit
      ? { sha: entry.commit.sha, parent: entry.commit.parent }
      : null
    return {
      ...common,
      kind: entry.kind,
      label: entry.kind === "mixed" ? "regression" : entry.kind,
      class: entry.class,
      brief: entry.commit?.brief ?? null,
      commit,
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
