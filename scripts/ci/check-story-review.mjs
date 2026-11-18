// Every story says what it shows, so that the visual critic knows what it
// looks at (the Storybook skill, "Review annotations").
//
// Each story has a kind and a purpose:
//   - `parameters.review.kind`, a string literal: "page" for a whole screen
//     that a user lands on, or "component" for a part of the UI (a
//     component, a dialog, a step, a part of a page). It can be in the story
//     or in the `meta` of the file; the story wins.
//   - the purpose: the JSDoc description of the story itself, one sentence
//     or a short paragraph of 40 to 500 characters (line breaks count as
//     spaces): what the UI is for, how the user uses it, and the state that
//     the story shows. A note on what a test of the story proves can follow
//     in the same comment. It describes the UI, so it does not start with
//     "Shows", "Displays" or "Renders". The check cannot judge the meaning:
//     the critic reads it. Storybook shows the same text in its docs and in
//     `storybook tools docs show-story`.
//
// `parameters.review` has no other key than `kind`: an old
// `parameters.review.purpose` moved to the JSDoc (CTX-1375).
//
// The check fails for each story with no valid kind or purpose.
//
// Usage: node scripts/ci/check-story-review.mjs [repo root]   (default: this repo)

import { readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { csfTools } from "../../apps/ui/.storybook/check-modules.mjs"
import {
  storiesOf,
  storyFiles,
} from "../../packages/visual-review/src/story-tags.ts"

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
)
const csf = await csfTools()

const errors = []
let count = 0
for (const path of storyFiles(join(root, "apps/ui/src"))) {
  const file = relative(root, path)
  for (const story of storiesOf(csf, file, readFileSync(path, "utf8"))) {
    count += 1
    const where = `${file}: story "${story.name}"`
    if (!story.kind)
      errors.push(
        `${where} has no parameters.review.kind. Set "page" (a whole screen that a user lands on) or "component" (a component, a dialog, a step or a part of a page), in the story or in the meta.`,
      )
    const others = [...new Set(story.reviewKeys)].filter(
      (key) => key !== "kind",
    )
    if (others.length)
      errors.push(
        `${where}: parameters.review has ${others.map((key) => `"${key}"`).join(", ")}. It has only "kind": write the purpose in the JSDoc comment of the story (/** ... */ above its export).`,
      )
    if (!story.purpose)
      errors.push(
        `${where} has no purpose. Write one sentence or a short paragraph in the JSDoc comment of the story (/** ... */ above its export): what the UI is for, how the user uses it, and the state that the story shows.`,
      )
    else if (
      story.purpose.length < 40 ||
      story.purpose.length > 500 ||
      /^(Shows|Displays|Renders)\b/i.test(story.purpose)
    )
      errors.push(
        `${where}: the purpose must be 40 to 500 characters and must not start with "Shows", "Displays" or "Renders". Say what the UI is for, how the user uses it, and the state that the story shows.`,
      )
  }
}
for (const error of errors) console.error(error)
if (errors.length) process.exit(1)
console.log(`Story review check passed (${count} stories).`)
