import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { captureInContainer } from "./visual-capture.mjs"

// Proves that the capture container is deterministic: it captures a sample of
// stories two times in a row and compares the PNGs byte by byte.
//
// The sample is every n-th story of the static build, sorted by id, so it
// holds the same stories on each host. Only stories with a play function can
// be captured (the play runner ends a story at the play). The result is in .ci-results/visual-capture-proof/
// (proof.json, and the PNGs of both runs). The exit code is 1 when a story
// differs between the runs or does not capture.
//
// Usage: node scripts/ci/visual-capture-proof.mjs [sample size, default 20]

const root = fileURLToPath(new URL("../../", import.meta.url))
const out = join(root, ".ci-results/visual-capture-proof")
const size = Number(process.argv[2] ?? 20)

const index = JSON.parse(
  readFileSync(join(root, "apps/ui/storybook-static/index.json"), "utf8"),
)
const all = Object.values(index.entries)
  .filter((entry) => entry.type === "story" && entry.tags?.includes("play-fn"))
  .map((entry) => entry.id)
  .sort()
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

mkdirSync(out, { recursive: true })
writeFileSync(
  join(out, "proof.json"),
  `${JSON.stringify({ sample: ids.length, identical: results.filter((result) => result.identical).length, results }, null, 2)}\n`,
)
const differing = results.filter((result) => !result.identical)
process.stdout.write(
  `${results.length - differing.length} of ${results.length} stories gave identical PNGs in two runs.\n`,
)
for (const result of differing) process.stdout.write(`differs: ${result.id}\n`)
process.exitCode = differing.length ? 1 : 0
