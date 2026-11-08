// Runs in the pinned capture container (build.ts starts it). It plays each
// story of a job file with the play runner of the visual check, and takes the
// screenshots of the job: a clean one, and then, when the job asks, one more
// after a synthetic change (mutations.ts). Each PNG goes to /out, with
// /out/results.json (the status and the known region of each shot).
//
// Usage (in the container): node packages/visual-review/evals/critic/capture.ts <job file>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  playStories,
  serveStatic,
  waitFor,
  type IndexStory,
  type PlayPage,
} from "../../../../scripts/ci/storybook-play.mjs"
import { shootUntilSteady } from "../../../../scripts/ci/visual-capture.mjs"
import type { PixelBox } from "../../src/compare/diff.ts"
import {
  applyMutation,
  collectFacts,
  focusTarget,
  isNoise,
  knownRegion,
  planMutation,
  seeded,
  type MutationClass,
} from "./mutations.ts"

/** The screenshots of one story. */
export type StoryJob = {
  id: string
  /** The file name of the clean screenshot. */
  clean: string
  /** One more screenshot after a synthetic change, in the same page. */
  mutated?: { file: string; kind: MutationClass; seed: number }
}

/** The stories of one Storybook build, a folder from the repository root. */
export type Job = { build: string; stories: StoryJob[] }

export type ShotResult = {
  file: string
  status:
    | "captured"
    | "unstable"
    | "play-failed"
    | "capture-failed"
    | "no-target"
  error?: string
  /** For a mutated shot: the known region of the change. */
  region?: PixelBox | null
}

const out = "/out"

async function shoot(page: PlayPage, file: string): Promise<ShotResult> {
  const { steady, png } = await shootUntilSteady(
    () => page.screenshot({ type: "png", animations: "disabled" }),
    () => page.waitForTimeout(250),
  )
  writeFileSync(join(out, file), png)
  return { file, status: steady ? "captured" : "unstable" }
}

async function captureStory(
  page: PlayPage,
  job: StoryJob,
): Promise<ShotResult[]> {
  if (!job.mutated) return [await shoot(page, job.clean)]
  const { file, kind, seed } = job.mutated
  const facts = await page.evaluate(collectFacts, kind === "focus-ring")
  const plan = planMutation(kind, facts, seeded(seed))
  if (plan?.focus) await page.evaluate(focusTarget, plan.target)
  const clean = await shoot(page, job.clean)
  if (!plan) return [clean, { file, status: "no-target" }]
  const before = facts.elements[plan.target]?.box
  const after = await page.evaluate(applyMutation, plan)
  const region =
    isNoise(kind) || !before
      ? null
      : knownRegion([before, ...after], facts.viewport)
  return [clean, { ...(await shoot(page, file)), region }]
}

// The results of a story whose play or capture failed: one for each shot.
const failed = (
  story: StoryJob,
  status: ShotResult["status"],
  error: string,
): ShotResult[] =>
  [story.clean, ...(story.mutated ? [story.mutated.file] : [])].map((file) => ({
    file,
    status,
    error,
  }))

async function run(jobs: Job[]) {
  mkdirSync(out, { recursive: true })
  const results: ShotResult[] = []
  try {
    for (const job of jobs) {
      const server = await serveStatic(join("/work", job.build), 0)
      try {
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        await waitFor(`${url}/index.json`)
        const index = (await (await fetch(`${url}/index.json`)).json()) as {
          entries: Record<string, IndexStory>
        }
        // One index entry for each job story; a story can have more jobs.
        const jobOf = new Map<IndexStory, StoryJob>()
        for (const story of job.stories) {
          const entry = index.entries[story.id]
          if (entry) jobOf.set({ ...entry }, story)
          else
            results.push(...failed(story, "play-failed", "Not in the build."))
        }
        await playStories(
          url,
          [...jobOf.keys()],
          () => undefined,
          false,
          async (page, entry, error) => {
            const story = jobOf.get(entry)
            if (!story) return
            if (error) {
              results.push(...failed(story, "play-failed", error))
              return
            }
            try {
              results.push(...(await captureStory(page, story)))
            } catch (shotError) {
              results.push(
                ...failed(story, "capture-failed", String(shotError)),
              )
            }
          },
        )
      } finally {
        await new Promise((resolveClose) => server.close(resolveClose))
      }
    }
  } finally {
    writeFileSync(
      join(out, "results.json"),
      `${JSON.stringify({ shots: results }, null, 2)}\n`,
    )
  }
}

if (import.meta.main)
  await run(JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as Job[])
