import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { runVisual } from "../../packages/visual-review/src/compare/baselines.ts"
import { threshold } from "../../packages/visual-review/src/compare/diff.ts"
import { csfTools } from "../../apps/ui/.storybook/check-modules.mjs"
import {
  readUnstable,
  visualRecords,
  visualSkips,
} from "../checks/visual.mjs"
import { captureInContainer, viewports } from "./visual-capture.mjs"
import pin from "./visual-container.json" with { type: "json" }

// `pnpm visual:check` and `pnpm visual:update [--only <id>,<id>... | --failed]`.
//
// Both commands capture the stories of the static Storybook build
// (apps/ui/storybook-static) in the pinned container
// (scripts/ci/visual-capture.mjs) and compare each screenshot with its
// committed baseline:
// <story file dir>/screenshots/<storyfile>.<storyname>.<viewport>.screenshot.png.
//
// - check: writes the run into .ci-results/visual/ (manifest.json, and the
//   images of each story that is not unchanged). It never writes a baseline.
//   It fails on a story that is new, changed, removed (an orphan baseline),
//   unstable, play-failed or size-changed, and above the size budget. With
//   --only, it checks only those stories: it does not look for orphans, and
//   only the image budget of their baselines applies. With --records <dir>,
//   it also writes one result record for each story to <dir>/records.ndjson
//   (the visual checks, scripts/checks/visual.mjs).
// - update: writes the baselines of the selected stories (all, the story ids
//   of --only, or with --failed the stories that the last check failed), and
//   deletes the orphan baselines.
//
// The stories in scripts/ci/visual-unstable-stories.json have no baseline
// yet. Both commands skip them and name their ticket. A story with
// `parameters.visual.skip` (a reason) has no screenshot; both commands skip
// it and print the reason. The baseline of a skipped story is an orphan.
//
// Usage: node scripts/ci/visual.mjs check [--only <id>,<id>...] [--records <dir>]
//        node scripts/ci/visual.mjs update [--only <id>,<id>... | --failed]
// The pnpm scripts build Storybook first.

const root = fileURLToPath(new URL("../../", import.meta.url))
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: "string" },
    failed: { type: "boolean", default: false },
    records: { type: "string" },
  },
})
const mode = positionals[0]
const only = values.only?.split(",").filter(Boolean)
if (
  !["check", "update"].includes(mode) ||
  (mode === "check" && values.failed) ||
  (mode === "update" && values.records) ||
  (only && values.failed)
) {
  process.stderr.write(
    "Usage: node scripts/ci/visual.mjs check [--only <id>,<id>...] [--records <dir>]\n       node scripts/ci/visual.mjs update [--only <id>,<id>... | --failed]\n",
  )
  process.exit(2)
}

const index = JSON.parse(
  readFileSync(join(root, "apps/ui/storybook-static/index.json"), "utf8"),
)
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
  .toString()
  .trim()
const stories = Object.values(index.entries).filter(
  (entry) => entry.type === "story",
)
const skipped = visualSkips(stories, (await csfTools()).loadCsf)
for (const [id, reason] of skipped)
  process.stdout.write(`skipped: ${id} (parameters.visual.skip: ${reason})\n`)

const started = Date.now()
const result = await runVisual({
  mode,
  root,
  out: join(root, ".ci-results/visual"),
  stories: stories.filter((story) => !skipped.has(story.id)),
  unstable: readUnstable(),
  capture: async (viewport, ids) => {
    const dir = join(root, ".ci-results/visual-capture", viewport)
    const stories = await captureInContainer(ids, dir, viewport)
    return new Map(
      stories.map((story) => [
        story.id,
        {
          ...story,
          ...(["captured", "unstable"].includes(story.status) && {
            png: readFileSync(join(dir, `${story.id}.png`)),
          }),
        },
      ]),
    )
  },
  run: {
    imageDigest: pin.digest,
    playwrightVersion: pin.tag.replace(/^v/, "").replace(/-.*$/, ""),
    viewports,
    threshold,
    commit,
    // The baselines are the files of the checkout.
    baseRef: commit,
  },
  print: (line) => process.stdout.write(`${line}\n`),
  only,
  failed: values.failed,
})
if (values.records) {
  const directory = resolve(values.records)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, "records.ndjson"),
    visualRecords(result, Date.now() - started)
      .map((record) => `${JSON.stringify({ schemaVersion: 1, ...record })}\n`)
      .join(""),
  )
}
process.exitCode = result.code
