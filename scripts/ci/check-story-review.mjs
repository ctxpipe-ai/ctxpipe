// Every story says what it shows, so that the visual critic knows what it
// looks at (the Storybook skill, "Review annotations").
//
// Each story has `parameters.review` with two string literals:
//   - `kind`: "page" for a whole screen that a user lands on, or "component"
//     for a part of the UI (a component, a dialog, a step, a part of a page).
//     It can be in the story or in the `meta` of the file; the story wins.
//   - `purpose`: one sentence in the story itself, on one line of 60 to 240
//     characters, in two parts. Before the first ": ", the UI and what the
//     user uses it for. After it, the state that the story shows and the
//     step of the user that led there. It does not describe the story
//     ("Shows", "Displays", "Renders", "This story", "Example").
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
const { loadCsf } = await csfTools()

function validPurpose(purpose) {
  const colon = purpose.indexOf(": ")
  return (
    purpose.length >= 60 &&
    purpose.length <= 240 &&
    !purpose.includes("\n") &&
    colon > 0 &&
    purpose.slice(colon + 2).trim().length > 0 &&
    !/^(Shows|Displays|Renders|This story|Example)\b/i.test(purpose)
  )
}

const errors = []
let count = 0
for (const path of storyFiles(join(root, "apps/ui/src"))) {
  const file = relative(root, path)
  for (const story of storiesOf(loadCsf, file, readFileSync(path, "utf8"))) {
    count += 1
    const where = `${file}: story "${story.name}"`
    if (!story.kind)
      errors.push(
        `${where} has no parameters.review.kind. Set "page" (a whole screen that a user lands on) or "component" (a component, a dialog, a step or a part of a page), in the story or in the meta.`,
      )
    if (!story.purpose)
      errors.push(
        `${where} has no parameters.review.purpose. Write one sentence (a string literal) in the story: "<the UI>, where <the user> <does what>: <the state, and the step of the user that led there>."`,
      )
    else if (!validPurpose(story.purpose))
      errors.push(
        `${where}: parameters.review.purpose must be one line of 60 to 240 characters: "<the UI>, where <the user> <does what>: <the state, and the step of the user that led there>." It does not start with "Shows", "Displays", "Renders", "This story" or "Example".`,
      )
  }
}
for (const error of errors) console.error(error)
if (errors.length) process.exit(1)
console.log(`Story review check passed (${count} stories).`)
