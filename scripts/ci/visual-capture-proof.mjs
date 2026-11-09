import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { readUnstable } from "../checks/visual.mjs"
import { captureInContainer } from "./visual-capture.mjs"

// Proves that the capture container is deterministic: it captures a sample of
// stories two times in a row and compares the PNGs byte by byte.
//
// The sample is every n-th story of the static build, sorted by id, so it
// holds the same stories on each host. A story with or without a play function
// can be in the sample. The result is in .ci-results/visual-capture-proof/
// (proof.json, and the PNGs of both runs). The exit code is 1 when a story
// differs between the runs, is unstable in a run, or does not capture. A
// story in scripts/ci/visual-unstable-stories.json is known to differ: it is
// reported as skipped and does not fail the run. The nightly CI run (the job
// "Screenshot determinism" in .github/workflows/ci.yaml) runs it.
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
  const all = Object.values(index.entries)
    .filter((entry) => entry.type === "story")
    .map((entry) => entry.id)
    .sort()
  if (!all.length) throw new Error("The Storybook build has no story.")
  const size =
    process.argv[2] === "all"
      ? all.length
      : Math.min(Number(process.argv[2] ?? 20), all.length)
  const ids = Array.from(
    { length: size },
    (_, k) => all[Math.floor((k * all.length) / size)],
  )

  const sha = (file) =>
    createHash("sha256").update(readFileSync(file)).digest("hex")

  const runs = []
  for (const run of [1, 2]) {
    const directory = join(out, `run-${run}`)
    const stories = await captureInContainer(ids, directory)
    runs.push({ directory, stories })
  }

  const results = ids.map((id) => {
    const [first, second] = runs.map(({ directory, stories }) => {
      const story = stories.find((entry) => entry.id === id)
      return story?.status === "captured"
        ? { status: "captured", sha256: sha(join(directory, `${id}.png`)) }
        : { status: story?.status ?? "missing", error: story?.error }
    })
    const identical =
      first.status === "captured" &&
      second.status === "captured" &&
      first.sha256 === second.sha256
    return { id, identical, runs: [first, second] }
  })

  const { skipped, failing } = judgeProof(results, readUnstable())

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
      `differs: ${result.id} (${result.runs.map((run) => run.status).join(", ")})\n`,
    )
  process.exitCode = failing.length ? 1 : 0
}
