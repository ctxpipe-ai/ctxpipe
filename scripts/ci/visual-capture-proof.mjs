import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { readUnstable } from "../checks/visual.mjs"
import { selectTracedStories } from "./storybook-select.mjs"
import {
  captureInContainer,
  capturePlan,
  shotKey,
} from "./visual-capture.mjs"

// Proves that the capture container is deterministic: it captures a sample of
// stories two times in a row and compares the PNGs byte by byte.
//
// The sample is every n-th story of the static build, sorted by id, so it
// holds the same stories on each host. A story with or without a play function
// can be in the sample. The result is in .ci-results/visual-capture-proof/
// (proof.json, and the PNGs of both runs). The exit code is 1 when a story
// differs between the runs, is unstable in a run, or does not capture. A
// story in scripts/ci/visual-unstable-stories.json is known to differ: it is
// reported as skipped and does not fail the run. No CI job runs it: the
// nightly run finds a flaky screenshot by the contradiction rule (a check
// that fails and then passes in its rerun, scripts/ci/nightly.mjs).
//
// Usage: node scripts/ci/visual-capture-proof.mjs [sample size, default 20, or "all"]

// Splits the stories that are not identical in the two runs: a story that is
// listed for the desktop viewport (the viewport of the proof) is skipped, and
// any other story fails the proof.
export function judgeProof(results, unstable) {
  const known = new Set(
    unstable
      .filter((entry) => (entry.viewport ?? "desktop") === "desktop")
      .map((entry) => entry.id),
  )
  const differing = results.filter((result) => !result.identical)
  return {
    skipped: differing.filter((result) => known.has(result.id)),
    failing: differing.filter((result) => !known.has(result.id)),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prove()

async function prove() {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const out = join(root, ".ci-results/visual-capture-proof")

  const index = JSON.parse(
    readFileSync(join(root, "apps/ui/storybook-static/index.json"), "utf8"),
  )
  const stories = selectTracedStories(index)
  const all = stories.map((entry) => entry.id)
  if (!all.length) throw new Error("The Storybook build has no story.")
  const sample = process.argv[2]
  const size =
    sample === "all" ? all.length : Math.min(Number(sample ?? 20), all.length)
  const ids = Array.from(
    { length: size },
    (_, k) => all[Math.floor((k * all.length) / size)],
  )

  const sha = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex")

  const plan = await capturePlan(ids)
  const runs = []
  for (const run of [1, 2]) {
    const directory = join(out, `run-${run}`)
    const shots = await captureInContainer(plan, directory)
    runs.push({ directory, shots })
  }

  // A story is identical when each of its shots (the end state and each
  // named snapshot) is.
  const results = ids.map((id) => {
    const [first, second] = runs.map(({ directory, shots }) =>
      shots
        .filter((shot) => shot.id === id)
        .map((shot) =>
          shot.status === "captured"
            ? {
                ...(shot.snapshot && { snapshot: shot.snapshot }),
                status: "captured",
                sha256: sha(
                  join(directory, `${shotKey(id, shot.snapshot)}.png`),
                ),
              }
            : {
                ...(shot.snapshot && { snapshot: shot.snapshot }),
                status: shot.status,
                error: shot.error,
              },
        ),
    )
    const identical = first.every(
      (shot, i) =>
        shot.status === "captured" &&
        second[i]?.status === "captured" &&
        shot.sha256 === second[i].sha256,
    )
    return { id, identical, runs: [first, second] }
  })

  const unstable = readUnstable()
  const { skipped, failing } = judgeProof(results, unstable)

  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, "proof.json"),
    `${JSON.stringify({ sample: ids.length, identical: results.filter((result) => result.identical).length, skipped: skipped.map((result) => result.id), results }, null, 2)}\n`,
  )
  process.stdout.write(
    `${results.filter((result) => result.identical).length} of ${results.length} stories gave identical PNGs in two runs; ${skipped.length} known unstable stories skipped.\n`,
  )
  for (const result of skipped)
    process.stdout.write(
      `skipped: ${result.id} (${unstable.find((entry) => entry.id === result.id).ticket})\n`,
    )
  for (const result of failing)
    process.stdout.write(
      `differs: ${result.id} (${result.runs.map((run) => run.map((shot) => shot.status).join("/")).join(", ")})\n`,
    )
  process.exitCode = failing.length ? 1 : 0
}
